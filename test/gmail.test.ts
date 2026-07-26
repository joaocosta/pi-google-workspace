import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { OAuthClient, WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import {
  createGmailClientProvider,
  type GmailClient,
  type GmailClientProvider,
} from "../src/gmail/client.js";
import { buildGmailSearchQuery, registerGmail } from "../src/gmail/index.js";
import { nestedMultipartMessage } from "./fixtures/gmail-messages.js";

type ToolOptions = {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: Function;
};

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

function register(clientProvider: GmailClientProvider) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerGmail(pi as never, { auth: authService(), clientProvider });
  return { tools, pi };
}

function mockClient(): GmailClient {
  return {
    users: {
      drafts: { create: vi.fn(async () => ({ data: {} })) },
      messages: {
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
      "gws_gmail_create_draft",
      "gws_gmail_move_message",
    ]);
    for (const [name, tool] of tools) {
      expect(`${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`).toContain(name);
    }
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
    const output = JSON.parse(result.content[0].text);
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

    expect(search.isError).toBe(true);
    expect(search.content[0].text).toContain("query must not be blank");
    expect(read.isError).toBe(true);
    expect(read.content[0].text).toContain("ID must not be blank");
    expect(provider.getClient).not.toHaveBeenCalled();
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
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      id: "msg-synthetic-1",
      messageId: "<synthetic-1@example.test>",
      body: "First plain section\n\nSecond plain section",
    });
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
    expect(result.content[0].text).toContain("/gws-login gmail");
    expect(JSON.stringify(result)).not.toMatch(/secret-token|secret-client|access_token|client_secret/);
  });
});
