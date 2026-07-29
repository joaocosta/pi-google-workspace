import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

describe("package presentation", () => {
  it("packs only production source and user documentation", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

    expect(manifest.files).toEqual(["src", "docs", "README.md", "LICENSE"]);
    expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"] });
    expect(Object.keys(manifest.dependencies).sort()).toEqual(["googleapis", "luxon"]);
    expect(Object.keys(manifest.peerDependencies).sort()).toEqual([
      "@earendil-works/pi-coding-agent",
      "typebox",
    ]);
    await Promise.all(
      ["README.md", "LICENSE", "docs/development.md"].map((path) =>
        access(new URL(path, root)),
      ),
    );
  });

  it("documents exact OAuth paths and minimum scopes without legacy public commands", async () => {
    const readme = await readFile(new URL("README.md", root), "utf8");

    expect(readme).toContain("~/.pi/agent/gws-oauth/client_secret.json");
    expect(readme).toContain("~/.pi/agent/gws-oauth/gmail-token.json");
    expect(readme).toContain("~/.pi/agent/gws-oauth/calendar-token.json");
    expect(readme).toContain("https://www.googleapis.com/auth/gmail.modify");
    expect(readme).toContain("gws_gmail_download_attachment");
    expect(readme).toContain("25 MiB");
    expect(readme).toContain("cleanup is caller-owned");
    expect(readme).toContain(
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    );
    expect(readme).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(readme).not.toMatch(/\/(?:gmail|google)-(?:login|status|logout)\b/);
    expect(readme).not.toContain("~/.pi/agent/google-oauth");
    expect(readme).not.toContain("~/.pi/agent/gmail-oauth");
    expect(readme).not.toContain("https://www.googleapis.com/auth/calendar\n");
  });
});
