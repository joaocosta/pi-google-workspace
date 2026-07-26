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

  it("imports without side effects and registers no features yet", () => {
    const pi = { registerCommand: vi.fn(), registerTool: vi.fn() };

    expect(() => googleWorkspace(pi as never)).not.toThrow();
    expect(pi.registerCommand).not.toHaveBeenCalled();
    expect(pi.registerTool).not.toHaveBeenCalled();
  });
});
