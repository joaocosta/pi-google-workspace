import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import { registerAuthCommands } from "../src/extension/commands.js";

type CommandOptions = {
  handler(args: string, ctx: ExtensionCommandContext): Promise<void>;
};

function harness(overrides: Partial<WorkspaceAuthService> = {}) {
  const apps = createWorkspaceAppRegistry(createTokenStore({ homeRoot: "/fixture-home" }));
  const auth: WorkspaceAuthService = {
    apps,
    login: vi.fn(async (_app, showUrl) => showUrl("https://accounts.example/safe-url")),
    getAuthenticatedClient: vi.fn(),
    getStatus: vi.fn(async () => ({
      client: "present" as const,
      apps: { gmail: "present" as const, calendar: "missing" as const },
    })),
    logout: vi.fn(async () => undefined),
    ...overrides,
  };
  const commands = new Map<string, CommandOptions>();
  const pi = {
    registerCommand: vi.fn((name: string, options: CommandOptions) => commands.set(name, options)),
  };
  registerAuthCommands(pi as never, auth);
  return { auth, commands, pi };
}

function context(options: { hasUI?: boolean; selected?: string; confirmed?: boolean } = {}) {
  const ui = {
    notify: vi.fn(),
    select: vi.fn(async () => options.selected),
    confirm: vi.fn(async () => options.confirmed ?? true),
  };
  return { ctx: { hasUI: options.hasUI ?? true, ui } as never as ExtensionCommandContext, ui };
}

describe("shared authentication commands", () => {
  it("registers exactly the three prefixed commands", () => {
    const { commands } = harness();
    expect([...commands.keys()]).toEqual(["gws-login", "gws-status", "gws-logout"]);
  });

  it("uses a selector for omitted interactive login and displays the manual URL", async () => {
    const { auth, commands } = harness();
    const { ctx, ui } = context({ selected: "Calendar (calendar)" });

    await commands.get("gws-login")!.handler("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Select an app to login", ["Gmail (gmail)", "Calendar (calendar)"]);
    expect(auth.login).toHaveBeenCalledWith("calendar", expect.any(Function));
    expect(ui.notify).toHaveBeenCalledWith(expect.stringContaining("https://accounts.example/safe-url"), "info");
  });

  it("returns usage without authorizing when an app is omitted headlessly", async () => {
    const { auth, commands } = harness();
    const { ctx, ui } = context({ hasUI: false });

    await commands.get("gws-login")!.handler("", ctx);

    expect(auth.login).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("Usage: /gws-login gmail|calendar", "info");
  });

  it("shows local all-app or selected status without credential contents", async () => {
    const { commands } = harness();
    const all = context();
    await commands.get("gws-status")!.handler("", all.ctx);
    const allMessage = all.ui.notify.mock.calls[0]?.[0] as string;
    expect(allMessage).toContain("Shared OAuth client: configured");
    expect(allMessage).toContain("Gmail: authenticated");
    expect(allMessage).toContain("Calendar: not authenticated (run /gws-login calendar)");
    expect(allMessage).not.toMatch(/access_token|refresh_token|fixture-secret/);

    const selected = context();
    await commands.get("gws-status")!.handler("gmail", selected.ctx);
    const selectedMessage = selected.ui.notify.mock.calls[0]?.[0] as string;
    expect(selectedMessage).toContain("Gmail: authenticated");
    expect(selectedMessage).not.toContain("Calendar:");
  });

  it("treats logout cancellation as a no-op and removes only an explicitly selected app", async () => {
    const { auth, commands } = harness();
    const cancelled = context({ confirmed: false });

    await commands.get("gws-logout")!.handler("gmail", cancelled.ctx);

    expect(auth.logout).not.toHaveBeenCalled();
    expect(cancelled.ui.notify).toHaveBeenCalledWith("Gmail logout cancelled.", "info");

    const confirmed = context({ confirmed: true });
    await commands.get("gws-logout")!.handler("calendar", confirmed.ctx);
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(auth.logout).toHaveBeenCalledWith("calendar");
  });

  it("sanitizes unexpected login failures", async () => {
    const authFailure = new Error("access_token=private refresh_token=private");
    const { commands } = harness({ login: vi.fn(async () => { throw authFailure; }) });
    const { ctx, ui } = context();

    await commands.get("gws-login")!.handler("gmail", ctx);

    expect(ui.notify).toHaveBeenCalledWith("Could not authenticate Gmail.", "error");
    expect(JSON.stringify(ui.notify.mock.calls)).not.toContain("private");
  });
});
