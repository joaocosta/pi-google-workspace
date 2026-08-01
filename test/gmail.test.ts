import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstText, type ToolOptions } from "./fixtures/tools.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { OAuthClient, WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import {
  createGmailClientProvider,
  type GmailClient,
  type GmailClientProvider,
} from "../src/gmail/client.js";
import type { GmailAttachmentDownloadDependencies } from "../src/gmail/attachments.js";
import { buildGmailSearchQuery, registerGmail } from "../src/gmail/index.js";
import { nestedMultipartMessage } from "./fixtures/gmail-messages.js";



const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-gmail-tool-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function authService(overrides: Partial<WorkspaceAuthService> = {}): WorkspaceAuthService {
  return {
    apps: createWorkspaceAppRegistry(createTokenStore({ homeRoot: "/synthetic-home" })),
    login: vi.fn(),
    getAuthenticatedClient: vi.fn(),
    getStatus: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function register(
  clientProvider: GmailClientProvider,
  attachmentDownload?: Omit<GmailAttachmentDownloadDependencies, "clientProvider">,
) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerGmail(pi as never, {
    auth: authService(),
    clientProvider,
    ...(attachmentDownload === undefined ? {} : { attachmentDownload }),
  });
  return { tools, pi };
}

function mockClient(): GmailClient {
  return {
    users: {
      drafts: { create: vi.fn(async () => ({ data: {} })) },
      messages: {
        attachments: {
          get: vi.fn(async () => ({
            data: {
              data: Buffer.from([0, 255, 128, 65]).toString("base64url"),
              size: 4,
            },
          })),
        },
        list: vi.fn(async () => ({
          data: {
            messages: [
              { id: "msg-synthetic-1", threadId: "list-thread" },
              { threadId: "missing-id-thread" },
            ],
          },
        })),
        get: vi.fn(async (request: { format?: string }) => ({
          data:
            request.format === "full"
              ? nestedMultipartMessage
              : {
                  id: "msg-synthetic-1",
                  threadId: "thread-synthetic-1",
                  snippet: "Metadata snippet",
                  payload: {
                    headers: [
                      { name: "From", value: "Sender <sender@example.test>" },
                      { name: "To", value: "reader@example.test" },
                      { name: "Subject", value: "Synthetic result" },
                    ],
                  },
                },
        })),
        modify: vi.fn(async () => ({ data: {} })),
        trash: vi.fn(async () => ({ data: {} })),
        untrash: vi.fn(async () => ({ data: {} })),
      },
    },
  };
}

async function execute(tool: ToolOptions, params: object, signal?: AbortSignal) {
  return tool.execute("synthetic-call", params, signal, undefined, { hasUI: false });
}

describe("Gmail read tool registration", () => {
  it("registers the prefixed Gmail tools with explicit prompt guidance", () => {
    const { tools } = register({ getClient: vi.fn(async () => mockClient()) });

    expect([...tools.keys()]).toEqual([
      "gws_gmail_search",
      "gws_gmail_read_message",
      "gws_gmail_download_attachment",
      "gws_gmail_create_draft",
      "gws_gmail_create_reply_draft",
      "gws_gmail_move_message",
    ]);
    for (const [name, tool] of tools) {
      expect(`${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`).toContain(name);
    }

    const download = tools.get("gws_gmail_download_attachment")!;
    expect(Object.keys(download.parameters.properties)).toEqual([
      "messageId",
      "attachmentId",
      "outputFilename",
      "sourceFilename",
      "mediaType",
      "expectedSize",
    ]);
    expect(download.parameters.required).toEqual(["messageId", "attachmentId"]);
    expect(download.promptGuidelines?.join(" ")).toMatch(/explicit.*attachmentId|attachmentId.*explicit/i);
    expect(download.promptGuidelines?.join(" ")).toContain("verbatim");
    expect(tools.get("gws_gmail_read_message")!.promptGuidelines?.join(" ")).toContain(
      "gws_gmail_download_attachment",
    );
  });

  it("constructs bounded inbox queries and returns metadata without paging", async () => {
    const client = mockClient();
    const { tools } = register({ getClient: vi.fn(async () => client) });
    const signal = new AbortController().signal;
    const result = await execute(
      tools.get("gws_gmail_search")!,
      { query: " from:sender@example.test ", maxResults: 99 },
      signal,
    );

    expect(client.users.messages.list).toHaveBeenCalledWith(
      {
        userId: "me",
        q: "in:inbox -in:spam -in:trash -in:snoozed (from:sender@example.test)",
        includeSpamTrash: false,
        maxResults: 20,
      },
      { signal },
    );
    expect(client.users.messages.get).toHaveBeenCalledTimes(1);
    expect(client.users.messages.get).toHaveBeenCalledWith(
      {
        userId: "me",
        id: "msg-synthetic-1",
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      },
      { signal },
    );
    const output = JSON.parse(firstText(result));
    expect(output[0]).toMatchObject({
      id: "msg-synthetic-1",
      threadId: "thread-synthetic-1",
      from: "Sender <sender@example.test>",
      to: "reader@example.test",
      subject: "Synthetic result",
      date: "",
      snippet: "Metadata snippet",
    });
    expect(output[1]).toMatchObject({ threadId: "missing-id-thread", from: "", to: "" });
    expect(result.details).toEqual({ app: "gmail", count: 2 });
  });

  it("preserves all-mail syntax, explicit spam intent, and defaults", async () => {
    const client = mockClient();
    const { tools } = register({ getClient: vi.fn(async () => client) });

    await execute(tools.get("gws_gmail_search")!, {
      query: "in:trash synthetic",
      scope: "all_mail",
      includeSpamTrash: true,
    });

    expect(client.users.messages.list).toHaveBeenCalledWith(
      expect.objectContaining({
        q: "in:trash synthetic",
        includeSpamTrash: true,
        maxResults: 10,
      }),
      { signal: undefined },
    );
    expect(buildGmailSearchQuery("  newer_than:7d  ")).toBe(
      "in:inbox -in:spam -in:trash -in:snoozed (newer_than:7d)",
    );
  });

  it("rejects blank required inputs before authentication or API calls", async () => {
    const provider = { getClient: vi.fn(async () => mockClient()) };
    const { tools } = register(provider);

    const search = await execute(tools.get("gws_gmail_search")!, { query: "   " });
    const read = await execute(tools.get("gws_gmail_read_message")!, { id: "   " });
    const download = await execute(tools.get("gws_gmail_download_attachment")!, {
      messageId: "message",
      attachmentId: "   ",
    });

    expect(search.isError).toBe(true);
    expect(firstText(search)).toContain("query must not be blank");
    expect(read.isError).toBe(true);
    expect(firstText(read)).toContain("ID must not be blank");
    expect(download.isError).toBe(true);
    expect(firstText(download)).toBe("attachmentId must not be blank.");
    expect(provider.getClient).not.toHaveBeenCalled();
  });

  it("keeps unsafe names and provider secrets out of attachment tool failures", async () => {
    const provider = {
      getClient: vi.fn(async () => {
        throw new Error("access_token=secret-token /private/unsafe/path");
      }),
    };
    const { tools } = register(provider);
    const tool = tools.get("gws_gmail_download_attachment")!;

    const unsafeName = await execute(tool, {
      messageId: "message",
      attachmentId: "attachment",
      outputFilename: "../private-fixture.bin",
    });
    expect(unsafeName.isError).toBe(true);
    expect(JSON.stringify(unsafeName)).not.toMatch(/private-fixture|\.\.\//);
    expect(provider.getClient).not.toHaveBeenCalled();

    const apiFailure = await execute(tool, {
      messageId: "message",
      attachmentId: "attachment",
      outputFilename: "safe.bin",
    });
    expect(apiFailure.isError).toBe(true);
    expect(JSON.stringify(apiFailure)).not.toMatch(/secret-token|access_token|private\/unsafe/);
  });

  it("reads and parses a full message while forwarding abort signals", async () => {
    const client = mockClient();
    const { tools } = register({ getClient: vi.fn(async () => client) });
    const signal = new AbortController().signal;

    const result = await execute(
      tools.get("gws_gmail_read_message")!,
      { id: "msg-synthetic-1" },
      signal,
    );

    expect(client.users.messages.get).toHaveBeenCalledWith(
      { userId: "me", id: "msg-synthetic-1", format: "full" },
      { signal },
    );
    expect(JSON.parse(firstText(result))).toMatchObject({
      id: "msg-synthetic-1",
      messageId: "<synthetic-1@example.test>",
      body: "First plain section\n\nSecond plain section",
    });
  });

  it("runs search → one full read → one explicit download without refetching the message", async () => {
    const root = await temporaryRoot();
    const client = mockClient();
    const { tools } = register(
      { getClient: vi.fn(async () => client) },
      { cwd: () => root, temporaryToken: () => "0123456789abcdef0123456789abcdef" },
    );
    const signal = new AbortController().signal;

    await execute(tools.get("gws_gmail_search")!, { query: "has:attachment" }, signal);
    const readResult = await execute(
      tools.get("gws_gmail_read_message")!,
      { id: "msg-synthetic-1" },
      signal,
    );
    const readMessage = JSON.parse(firstText(readResult));
    const selected = readMessage.attachments[0];
    const downloadResult = await execute(
      tools.get("gws_gmail_download_attachment")!,
      {
        messageId: readMessage.id,
        attachmentId: selected.attachmentId,
        outputFilename: "selected-report.pdf",
        sourceFilename: selected.filename,
        mediaType: selected.mediaType,
        expectedSize: selected.size,
      },
      signal,
    );

    const messageGetCalls = vi.mocked(client.users.messages.get).mock.calls;
    expect(messageGetCalls.filter(([request]) => request.format === "full")).toHaveLength(1);
    expect(messageGetCalls.filter(([request]) => request.format === "metadata")).toHaveLength(1);
    expect(client.users.messages.attachments.get).toHaveBeenCalledTimes(1);
    expect(client.users.messages.attachments.get).toHaveBeenCalledWith(
      { userId: "me", messageId: "msg-synthetic-1", id: "attachment-report" },
      { signal },
    );
    expect(Object.keys(JSON.parse(firstText(downloadResult)))).toEqual([
      "path",
      "mediaType",
      "sizeBytes",
      "sizeHuman",
    ]);
    expect(JSON.parse(firstText(downloadResult))).toEqual({
      path: "./selected-report.pdf",
      mediaType: "application/pdf",
      sizeBytes: 4,
      sizeHuman: "4 B",
    });
    expect(await fs.readFile(join(root, "selected-report.pdf"))).toEqual(Buffer.from([0, 255, 128, 65]));
    expect(firstText(downloadResult)).not.toContain(
      Buffer.from([0, 255, 128, 65]).toString("base64url"),
    );
  });

  it("serializes a bounded relative warning after successful publication", async () => {
    const client = mockClient();
    const events: string[] = [];
    const token = "abcdef0123456789abcdef0123456789";
    const { tools } = register(
      { getClient: vi.fn(async () => client) },
      {
        cwd: () => "/synthetic-root",
        temporaryToken: () => token,
        fs: {
          lstat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
          open: async () => ({
            writeFile: async () => { events.push("write"); },
            sync: async () => { events.push("sync"); },
            close: async () => { events.push("close"); },
          }),
          link: async () => { events.push("link"); },
          unlink: async () => { throw new Error("cleanup path /synthetic-root must stay hidden"); },
        },
      },
    );

    const result = await execute(tools.get("gws_gmail_download_attachment")!, {
      messageId: "msg-synthetic-1",
      attachmentId: "attachment-report",
      outputFilename: "report.pdf",
    });

    expect(events).toEqual(["write", "sync", "close", "link"]);
    expect(JSON.parse(firstText(result))).toEqual({
      path: "./report.pdf",
      mediaType: "application/octet-stream",
      sizeBytes: 4,
      sizeHuman: "4 B",
      warnings: [`./.gws-gmail-attachment-${token}.tmp`],
    });
    expect(firstText(result)).not.toContain("/synthetic-root");
  });

  it("uses only Gmail auth and sanitizes authentication/client failures", async () => {
    const oauthClient = {} as OAuthClient;
    const getAuthenticatedClient = vi.fn(async () => oauthClient);
    const factory = vi.fn(() => mockClient());
    const provider = createGmailClientProvider(authService({ getAuthenticatedClient }), factory);

    await provider.getClient();
    expect(getAuthenticatedClient).toHaveBeenCalledWith("gmail");
    expect(factory).toHaveBeenCalledWith(oauthClient);

    const { tools } = register({
      getClient: vi.fn(async () => {
        throw new Error("access_token=secret-token client_secret=secret-client");
      }),
    });
    const result = await execute(tools.get("gws_gmail_read_message")!, { id: "missing" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("/gws-login gmail");
    expect(JSON.stringify(result)).not.toMatch(/secret-token|secret-client|access_token|client_secret/);
  });
});
