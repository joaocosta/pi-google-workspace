import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import googleWorkspace from "../src/index.js";

describe("extension composition root", () => {
  it("is the sole extension declared by the package", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest).toMatchObject({
      name: "pi-google-workspace",
      type: "module",
      pi: { extensions: ["./src/index.ts"] },
    });
  });

  it("imports without I/O, registers commands and tools, and switches only its own tools", async () => {
    let activeTools = ["read"];
    let gwsEnabled = false;
    const handlers = new Map<string, () => void>();
    const commands = new Map<string, { handler(args: string, ctx: never): Promise<void> }>();
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn((name: string) => (name === "gws-enabled" ? gwsEnabled : undefined)),
      registerCommand: vi.fn((name: string, options: { handler(args: string, ctx: never): Promise<void> }) => {
        commands.set(name, options);
      }),
      registerTool: vi.fn((tool: { name: string }) => activeTools.push(tool.name)),
      getActiveTools: vi.fn(() => [...activeTools]),
      setActiveTools: vi.fn((names: string[]) => {
        activeTools = [...names];
      }),
      on: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    };

    expect(() => { googleWorkspace(pi as never); }).not.toThrow();
    expect(pi.registerFlag).toHaveBeenCalledWith("gws-enabled", {
      description: "Start with Google Workspace tools enabled",
      type: "boolean",
      default: false,
    });
    expect(pi.registerCommand.mock.calls.map(([name]) => name)).toEqual([
      "gws",
      "gws-login",
      "gws-status",
      "gws-logout",
    ]);
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "gws_gmail_search",
      "gws_gmail_read_message",
      "gws_gmail_download_attachment",
      "gws_gmail_create_draft",
      "gws_gmail_create_reply_draft",
      "gws_gmail_move_message",
      "gws_calendar_list",
      "gws_calendar_list_events",
      "gws_calendar_create_event",
    ]);

    handlers.get("session_start")!();
    expect(activeTools).toEqual(["read"]);

    const ctx = { ui: { notify: vi.fn() } } as never;
    await commands.get("gws")!.handler("on", ctx);
    expect(activeTools).toEqual(["read", ...pi.registerTool.mock.calls.map(([tool]) => tool.name)]);

    await commands.get("gws")!.handler("off", ctx);
    expect(activeTools).toEqual(["read"]);

    gwsEnabled = true;
    handlers.get("session_start")!();
    expect(activeTools).toEqual(["read", ...pi.registerTool.mock.calls.map(([tool]) => tool.name)]);
  });
});
