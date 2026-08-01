import type { gmail_v1 } from "googleapis";
import { firstText, type ToolOptions } from "./fixtures/tools.js";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import type { GmailClient, GmailClientProvider } from "../src/gmail/client.js";
import { registerGmail } from "../src/gmail/index.js";
import {
  appendReplyReference,
  deriveReplyDraft,
  extractFirstMailbox,
  GmailReplyDerivationError,
  normalizeReplySubject,
} from "../src/gmail/reply.js";



function authService(): WorkspaceAuthService {
  return {
    apps: createWorkspaceAppRegistry(createTokenStore({ homeRoot: "/synthetic-home" })),
    login: vi.fn(),
    getAuthenticatedClient: vi.fn(),
    getStatus: vi.fn(),
    logout: vi.fn(),
  };
}

function source(headers: gmail_v1.Schema$MessagePartHeader[], threadId: string | null = "thread-parent") {
  return { id: "parent-message", threadId, payload: { headers } } satisfies gmail_v1.Schema$Message;
}

const sourceHeaders = [
  { name: "Reply-To", value: 'Reply Desk <reply@example.test>, ignored@example.test' },
  { name: "From", value: '"Synthetic Sender" <sender@example.test>' },
  { name: "Subject", value: "Re: Existing topic" },
  { name: "Message-ID", value: "<parent@example.test>" },
  { name: "References", value: "<root@example.test>" },
  { name: "Date", value: "Thu, 01 Jan 2026 12:00:00 +0000" },
];

function mockClient(message = source(sourceHeaders)) {
  const create = vi.fn<(...args: any[]) => Promise<any>>(async () => ({
    data: { id: "reply-draft", message: { id: "reply-message", threadId: "thread-parent" } },
  }));
  const get = vi.fn<(...args: any[]) => Promise<any>>(async () => ({ data: message }));
  const client = {
    users: {
      drafts: { create },
      messages: {
        get,
        list: vi.fn(),
        modify: vi.fn(),
        trash: vi.fn(),
        untrash: vi.fn(),
      },
    },
  } as unknown as GmailClient;
  return { client, create, get };
}

function register(clientProvider: GmailClientProvider) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerGmail(pi as never, { auth: authService(), clientProvider });
  return tools.get("gws_gmail_create_reply_draft")!;
}

function context(hasUI: boolean, confirmed = true) {
  return {
    hasUI,
    ui: {
      confirm: vi.fn<(title: string, message: string) => Promise<boolean>>(async () => confirmed),
    },
  };
}

async function execute(tool: ToolOptions, input: object, ctx = context(false), signal?: AbortSignal) {
  return tool.execute("synthetic-call", input, signal, undefined, ctx);
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("Gmail reply derivation", () => {
  it("extracts one mailbox from display-name and multi-recipient headers", () => {
    expect(extractFirstMailbox('"Doe, Jane" <jane@example.test>, other@example.test')).toBe(
      "jane@example.test",
    );
    expect(extractFirstMailbox("first@example.test, second@example.test")).toBe(
      "first@example.test",
    );
    expect(extractFirstMailbox("not a mailbox")).toBeUndefined();
    expect(extractFirstMailbox("malformed, valid@example.test")).toBeUndefined();
  });

  it("normalizes reply subjects and appends the parent reference only once", () => {
    expect(normalizeReplySubject(" Topic ")).toBe("Re: Topic");
    expect(normalizeReplySubject("RE : Existing")).toBe("RE : Existing");
    expect(appendReplyReference("<root> <parent>", "<parent>")).toBe("<root> <parent>");
    expect(appendReplyReference("<root>", "<parent>")).toBe("<root> <parent>");
    expect(appendReplyReference("", "<parent>")).toBe("<parent>");
  });

  it("prefers Reply-To, falls back to From, and rejects malformed preferred recipients", () => {
    expect(deriveReplyDraft(source(sourceHeaders), "parent-message").to).toBe("reply@example.test");
    expect(
      deriveReplyDraft(
        source(sourceHeaders.filter((header) => header.name !== "Reply-To")),
        "parent-message",
      ).to,
    ).toBe("sender@example.test");

    const malformed = source([
      ...sourceHeaders.filter((header) => header.name !== "Reply-To"),
      { name: "Reply-To", value: "malformed recipient" },
    ]);
    expect(() => deriveReplyDraft(malformed, "parent-message")).toThrow(GmailReplyDerivationError);
    expect(() =>
      deriveReplyDraft(
        source(sourceHeaders.filter((header) => !["Reply-To", "From"].includes(header.name))),
        "parent-message",
      ),
    ).toThrow(/no valid Reply-To or From mailbox/i);
  });

  it.each([
    ["Message-ID", sourceHeaders.filter((header) => header.name !== "Message-ID")],
    ["Gmail thread ID", source(sourceHeaders, null)],
  ])("fails actionably when %s is missing", (expected, fixture) => {
    const message = Array.isArray(fixture) ? source(fixture) : fixture;
    expect(() => deriveReplyDraft(message, "parent-message")).toThrow(expected);
  });
});

describe("gws_gmail_create_reply_draft", () => {
  it("documents source/body preview, one recipient, and never-send behavior", () => {
    const { client } = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) });
    const guidance = `${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`;

    expect(guidance).toContain("gws_gmail_create_reply_draft");
    expect(guidance).toMatch(/source message.*complete reply body/i);
    expect(guidance).toMatch(/one-recipient/i);
    expect(guidance).toMatch(/never send/i);
  });

  it("previews the source and full body, then creates in the Gmail and RFC thread", async () => {
    const { client, create, get } = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) });
    const ctx = context(true);
    const signal = new AbortController().signal;
    const body = "Complete reply\nSecond line 🌍";

    const result = await execute(tool, { id: " parent-message ", body }, ctx, signal);

    expect(get).toHaveBeenCalledWith(
      {
        userId: "me",
        id: "parent-message",
        format: "metadata",
        metadataHeaders: ["Reply-To", "From", "Subject", "Message-ID", "References", "Date"],
      },
      { signal },
    );
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Confirm Gmail reply draft",
      expect.stringContaining(body),
    );
    expect(ctx.ui.confirm.mock.calls[0]?.[1] ?? "").toContain(
      "Replying to: \"Synthetic Sender\" <sender@example.test>",
    );
    expect(create).toHaveBeenCalledWith(
      {
        userId: "me",
        requestBody: { message: { raw: expect.any(String), threadId: "thread-parent" } },
      },
      { signal },
    );
    const raw = decodeRaw(create.mock.calls[0]?.[0].requestBody.message.raw ?? "");
    expect(raw.match(/^To:/gm)).toHaveLength(1);
    expect(raw).toContain("To: reply@example.test\r\n");
    expect(raw).not.toContain("ignored@example.test");
    expect(raw).toContain("In-Reply-To: <parent@example.test>");
    expect(raw).toContain("References: <root@example.test> <parent@example.test>");
    expect(raw.endsWith(`\r\n\r\n${body}`)).toBe(true);
    expect(firstText(result)).toMatch(/reply-draft.*reply-message.*parent-message.*not been sent/i);
    expect(result.details).toEqual({
      app: "gmail",
      draftId: "reply-draft",
      messageId: "reply-message",
      parentMessageId: "parent-message",
      threadId: "thread-parent",
      to: "reply@example.test",
      subject: "Re: Existing topic",
    });
  });

  it("treats interactive cancellation as a non-error no-op", async () => {
    const { client, create, get } = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) });

    const result = await execute(tool, { id: "parent-message", body: "No mutation" }, context(true, false));

    expect(get).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ app: "gmail", cancelled: true, parentMessageId: "parent-message" });
  });

  it("executes headlessly after explicit caller intent and returns actionable derivation errors", async () => {
    const fallbackSource = source(sourceHeaders.filter((header) => header.name !== "Reply-To"));
    const { client, create } = mockClient(fallbackSource);
    const tool = register({ getClient: vi.fn(async () => client) });
    const ctx = context(false);

    await execute(tool, { id: "parent-message", body: "Explicit reply" }, ctx);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);

    const invalid = mockClient(source(sourceHeaders.filter((header) => header.name !== "Message-ID")));
    const invalidTool = register({ getClient: vi.fn(async () => invalid.client) });
    const result = await execute(invalidTool, { id: "parent-message", body: "Cannot thread" });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toMatch(/no Message-ID header/i);
    expect(invalid.create).not.toHaveBeenCalled();
  });

  it("sanitizes draft API failures without exposing credential material", async () => {
    const { client, create } = mockClient();
    create.mockRejectedValueOnce(
      new Error("access_token=synthetic-secret client_secret=synthetic-client"),
    );
    const tool = register({ getClient: vi.fn(async () => client) });

    const result = await execute(tool, { id: "parent-message", body: "Explicit reply" });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("/gws-login gmail");
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|synthetic-client|access_token|client_secret/,
    );
  });
});
