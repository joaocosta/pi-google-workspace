import { firstText, toolDetails, type ToolOptions } from "./fixtures/tools.js";
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

function register(clientProvider: GmailClientProvider) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerGmail(pi as never, { auth: authService(), clientProvider });
  return tools.get("gws_gmail_move_message")!;
}

function message(id: string, labelIds: string[] = ["INBOX", "STARRED"]) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds,
    payload: {
      headers: [
        { name: "From", value: "Sender <sender@example.test>" },
        { name: "Subject", value: `Subject ${id}` },
        { name: "Date", value: "Tue, 15 Jul 2025 10:00:00 +0000" },
      ],
    },
  };
}

function mockClient(labelIds: string[] = ["INBOX", "STARRED"]) {
  const get = vi.fn(async (request: { id?: string }) => ({
    data: message(request.id ?? "missing", labelIds),
  }));
  const modify = vi.fn(async (request: { id?: string; requestBody?: object }) => ({
    data: message(request.id ?? "missing", ["STARRED", "UPDATED"]),
  }));
  const trash = vi.fn(async (request: { id?: string }) => ({
    data: message(request.id ?? "missing", ["TRASH", "STARRED"]),
  }));
  const untrash = vi.fn(async (request: { id?: string }) => ({
    data: message(request.id ?? "missing", ["STARRED"]),
  }));
  const client = {
    users: { messages: { list: vi.fn(), get, modify, trash, untrash } },
  } as unknown as GmailClient;
  return { client, get, modify, trash, untrash };
}

function context(hasUI: boolean, confirmed = true) {
  return {
    hasUI,
    ui: { confirm: vi.fn(async () => confirmed) },
  };
}

async function execute(tool: ToolOptions, params: object, ctx = context(false), signal?: AbortSignal) {
  return tool.execute("synthetic-call", params, signal, undefined, ctx);
}

describe("Gmail move tool", () => {
  it("requires explicit intent in its prompt contract and exposes only bounded destinations", () => {
    const { client } = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) });
    const guidance = `${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`;

    expect(guidance).toContain("explicit");
    expect(guidance).toContain("sender, subject, and date");
    expect(guidance).toContain("one message at a time");
    expect(guidance).toContain("headless");
  });

  it("shows an accurate preview and treats interactive decline as a successful no-op", async () => {
    const { client, get, modify, trash, untrash } = mockClient(["INBOX", "STARRED"]);
    const tool = register({ getClient: vi.fn(async () => client) });
    const ctx = context(true, false);
    const signal = new AbortController().signal;

    const result = await execute(
      tool,
      { id: "msg-preview", destination: "archive", reason: "Requested cleanup" },
      ctx,
      signal,
    );

    expect(get).toHaveBeenCalledWith(
      {
        userId: "me",
        id: "msg-preview",
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      },
      { signal },
    );
    expect(ctx.ui.confirm).toHaveBeenCalledWith(
      "Confirm move to Archive",
      expect.stringMatching(
        /From: Sender <sender@example\.test>\nSubject: Subject msg-preview\nDate: Tue, 15 Jul 2025 10:00:00 \+0000\nID: msg-preview\nReason: Requested cleanup/,
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({
      app: "gmail",
      cancelled: true,
      id: "msg-preview",
      destination: "archive",
    });
    expect(modify).not.toHaveBeenCalled();
    expect(trash).not.toHaveBeenCalled();
    expect(untrash).not.toHaveBeenCalled();
  });

  it.each([
    ["inbox", { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] }],
    ["archive", { removeLabelIds: ["INBOX", "SPAM"] }],
    ["spam", { addLabelIds: ["SPAM"], removeLabelIds: ["INBOX"] }],
  ] as const)("moves to %s with only system-label changes", async (destination, requestBody) => {
    const { client, modify, trash, untrash } = mockClient(["INBOX", "STARRED", "Label_42"]);
    const tool = register({ getClient: vi.fn(async () => client) });
    const signal = new AbortController().signal;
    const ctx = context(false);

    const result = await execute(tool, { id: `msg-${destination}`, destination }, ctx, signal);

    expect(modify).toHaveBeenCalledWith(
      { userId: "me", id: `msg-${destination}`, requestBody },
      { signal },
    );
    expect(trash).not.toHaveBeenCalled();
    expect(untrash).not.toHaveBeenCalled();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(toolDetails(result)["previousLabelIds"]).toEqual(["INBOX", "STARRED", "Label_42"]);
    expect(toolDetails(result)["destination"]).toBe(destination);
  });

  it("uses Gmail trash while preserving the prior-label record", async () => {
    const { client, modify, trash, untrash } = mockClient(["INBOX", "IMPORTANT", "Label_42"]);
    const tool = register({ getClient: vi.fn(async () => client) });

    const result = await execute(tool, { id: "msg-trash", destination: "trash" });

    expect(trash).toHaveBeenCalledWith(
      { userId: "me", id: "msg-trash" },
      { signal: undefined },
    );
    expect(modify).not.toHaveBeenCalled();
    expect(untrash).not.toHaveBeenCalled();
    expect(toolDetails(result)["previousLabelIds"]).toEqual(["INBOX", "IMPORTANT", "Label_42"]);
    expect(toolDetails(result)["labelIds"]).toEqual(["TRASH", "STARRED"]);
  });

  it("restores a trashed message before applying its destination transition", async () => {
    const { client, modify, untrash } = mockClient(["TRASH", "STARRED", "Label_42"]);
    const tool = register({ getClient: vi.fn(async () => client) });

    await execute(tool, { id: "msg-restore", destination: "inbox" });

    expect(untrash).toHaveBeenCalledWith(
      { userId: "me", id: "msg-restore" },
      { signal: undefined },
    );
    expect(modify).toHaveBeenCalledWith(
      {
        userId: "me",
        id: "msg-restore",
        requestBody: { addLabelIds: ["INBOX"], removeLabelIds: ["SPAM"] },
      },
      { signal: undefined },
    );
    expect(untrash.mock.invocationCallOrder[0] ?? 0).toBeLessThan(modify.mock.invocationCallOrder[0] ?? 0);
  });

  it("rejects a blank ID before auth, preview, confirmation, or mutation", async () => {
    const { client } = mockClient();
    const provider = { getClient: vi.fn(async () => client) };
    const tool = register(provider);
    const ctx = context(true);

    const result = await execute(tool, { id: "  ", destination: "trash" }, ctx);

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("ID must not be blank");
    expect(provider.getClient).not.toHaveBeenCalled();
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it("sanitizes API failures without leaking credentials", async () => {
    const { client, modify } = mockClient();
    modify.mockRejectedValueOnce(
      new Error("access_token=synthetic-secret client_secret=synthetic-client"),
    );
    const tool = register({ getClient: vi.fn(async () => client) });

    const result = await execute(tool, { id: "msg-failure", destination: "archive" });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("/gws-login gmail");
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-secret|synthetic-client|access_token|client_secret/,
    );
  });

  it("serializes concurrent moves", async () => {
    let releaseTrash!: () => void;
    const trashGate = new Promise<void>((resolve) => {
      releaseTrash = resolve;
    });
    const { client, get, trash } = mockClient();
    trash.mockImplementationOnce(async (request: { id?: string }) => {
      await trashGate;
      return { data: message(request.id ?? "missing", ["TRASH"]) };
    });
    const tool = register({ getClient: vi.fn(async () => client) });

    const first = execute(tool, { id: "msg-first", destination: "trash" });
    const second = execute(tool, { id: "msg-second", destination: "archive" });
    await vi.waitFor(() => { expect(trash).toHaveBeenCalledTimes(1); });
    expect(get).toHaveBeenCalledTimes(1);

    releaseTrash();
    await Promise.all([first, second]);

    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls.map(([request]) => request.id)).toEqual(["msg-first", "msg-second"]);
  });

  it("releases the mutation queue after failure", async () => {
    const { client, get, modify } = mockClient();
    modify.mockRejectedValueOnce(new Error("synthetic API failure"));
    const tool = register({ getClient: vi.fn(async () => client) });

    const failed = execute(tool, { id: "msg-failed", destination: "archive" });
    const recovered = execute(tool, { id: "msg-recovered", destination: "archive" });
    const [failedResult, recoveredResult] = await Promise.all([failed, recovered]);

    expect(failedResult.isError).toBe(true);
    expect(recoveredResult.isError).toBeUndefined();
    expect(get.mock.calls.map(([request]) => request.id)).toEqual(["msg-failed", "msg-recovered"]);
    expect(modify).toHaveBeenCalledTimes(2);
  });
});
