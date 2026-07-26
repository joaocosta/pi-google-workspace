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

  it("imports without I/O and registers shared commands plus app tools", () => {
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn() };

    expect(() => googleWorkspace(pi as never)).not.toThrow();
    expect(pi.registerCommand.mock.calls.map(([name]) => name)).toEqual([
      "gws-login",
      "gws-status",
      "gws-logout",
    ]);
    expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
      "gws_gmail_search",
      "gws_gmail_read_message",
      "gws_gmail_create_draft",
      "gws_gmail_create_reply_draft",
      "gws_gmail_move_message",
      "gws_calendar_list",
      "gws_calendar_list_events",
      "gws_calendar_create_event",
    ]);
  });
});
