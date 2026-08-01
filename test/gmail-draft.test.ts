import { firstText, type ToolOptions } from "./fixtures/tools.js";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import type { GmailClient, GmailClientProvider } from "../src/gmail/client.js";
import { registerGmail } from "../src/gmail/index.js";



function authService(): WorkspaceAuthService {
  return {
    apps: createWorkspaceAppRegistry(createTokenStore({ homeRoot: "/synthetic-home" })),
    login: vi.fn(),
    getAuthenticatedClient: vi.fn(),
    getStatus: vi.fn(),
    logout: vi.fn(),
  };
}

function mockClient() {
  const create = vi.fn<(...args: any[]) => Promise<any>>(async () => ({
    data: {
      id: "draft-synthetic",
      message: { id: "message-synthetic", threadId: "thread-result" },
    },
  }));
  const client = {
    users: {
      drafts: { create },
      messages: {
        list: vi.fn(),
        get: vi.fn(),
        modify: vi.fn(),
        trash: vi.fn(),
        untrash: vi.fn(),
      },
    },
  } as unknown as GmailClient;
  return { client, create };
}

function register(clientProvider: GmailClientProvider) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerGmail(pi as never, { auth: authService(), clientProvider });
  return tools.get("gws_gmail_create_draft")!;
}

const params = {
  to: ["recipient@example.test"],
  subject: "Olá synthetic",
  body: "Full body\nSecond line 🌍",
};

function context(hasUI: boolean, confirmed = true) {
  return {
    hasUI,
    ui: { confirm: vi.fn<(title: string, message: string) => Promise<boolean>>(async () => confirmed) },
  };
}

async function execute(tool: ToolOptions, input: object, ctx = context(false), signal?: AbortSignal) {
  return tool.execute("synthetic-call", input, signal, undefined, ctx);
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

describe("gws_gmail_create_draft", () => {
  it("advertises explicit preview and never-send guidance", () => {
    const { client } = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) });
    const guidance = `${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`;

    expect(guidance).toContain("gws_gmail_create_draft");
    expect(guidance).toMatch(/recipients.*subject.*body/i);
    expect(guidance).toMatch(/never (?:claim|send)|not sent/i);
  });

  it("shows recipients, sanitized subject, and the full body before creating", async () => {
    const { client, create } = mockClient();
    const provider = { getClient: vi.fn(async () => client) };
    const tool = register(provider);
    const ctx = context(true);
    const signal = new AbortController().signal;

    const result = await execute(
      tool,
      {
        ...params,
        cc: ["copy@example.test"],
        bcc: ["hidden@example.test"],
        subject: "Olá\r\nX-Injected: no",
        threadId: "thread-input",
        inReplyTo: "<parent@example.test>",
        references: "<root@example.test> <parent@example.test>",
      },
      ctx,
      signal,
    );

    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Confirm Gmail draft",
      expect.stringContaining("To: recipient@example.test"),
    );
    const preview = ctx.ui.confirm.mock.calls[0]?.[1] ?? "";
    expect(preview).toContain("Cc: copy@example.test");
    expect(preview).toContain("Bcc: hidden@example.test");
    expect(preview).toContain("Subject: Olá X-Injected: no");
    expect(preview).toContain("Full body\nSecond line 🌍");
    expect(create).toHaveBeenCalledWith(
      {
        userId: "me",
        requestBody: {
          message: { raw: expect.any(String), threadId: "thread-input" },
        },
      },
      { signal },
    );
    const raw = decodeRaw(create.mock.calls[0]?.[0].requestBody.message.raw ?? "");
    expect(raw).toContain("Cc: copy@example.test\r\nBcc: hidden@example.test");
    expect(raw).toContain("In-Reply-To: <parent@example.test>");
    expect(raw).toContain("References: <root@example.test> <parent@example.test>");
    expect(raw).not.toContain("\r\nX-Injected:");
    expect(raw.endsWith("\r\n\r\nFull body\nSecond line 🌍")).toBe(true);
    expect(firstText(result)).toMatch(/draft-synthetic.*message-synthetic.*not been sent/i);
    expect(result.details).toEqual({
      app: "gmail",
      draftId: "draft-synthetic",
      messageId: "message-synthetic",
      threadId: "thread-result",
    });
  });

  it("treats declined confirmation as a successful no-op", async () => {
    const { client, create } = mockClient();
    const provider = { getClient: vi.fn(async () => client) };
    const tool = register(provider);

    const result = await execute(tool, params, context(true, false));

    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({ app: "gmail", cancelled: true });
    expect(firstText(result)).toMatch(/cancelled.*nothing was sent/i);
    expect(provider.getClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("executes headlessly from explicit caller intent without opening UI", async () => {
    const { client, create } = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) });
    const ctx = context(false);

    await execute(tool, params, ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("sanitizes API errors and does not claim the draft was sent", async () => {
    const { client, create } = mockClient();
    create.mockRejectedValueOnce(
      new Error("access_token=synthetic-secret client_secret=synthetic-client"),
    );
    const tool = register({ getClient: vi.fn(async () => client) });

    const result = await execute(tool, params);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("/gws-login gmail");
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|synthetic-client|access_token|client_secret/,
    );
  });
});
