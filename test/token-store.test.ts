import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOAuthPaths } from "../src/auth/paths.js";
import { createTokenStore, type TokenStoreFileSystem } from "../src/auth/token-store.js";

const temporaryRoots: string[] = [];

async function temporaryHome(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-gws-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("OAuth paths", () => {
  it("resolves the exact shared and app-specific paths under an injected home", () => {
    const paths = resolveOAuthPaths("/home/example");

    expect(paths).toEqual({
      configDirectory: "/home/example/.pi/agent/google-oauth",
      clientSecret: "/home/example/.pi/agent/google-oauth/client_secret.json",
      tokens: {
        gmail: "/home/example/.pi/agent/google-oauth/gmail-token.json",
        calendar: "/home/example/.pi/agent/google-oauth/calendar-token.json",
      },
    });
  });
});

describe("token store", () => {
  it("isolates all filesystem access beneath the injected home", async () => {
    const home = await temporaryHome();
    const store = createTokenStore({ homeRoot: home });

    await store.writeClientSecret({ installed: { client_id: "fixture-client" } });
    await store.writeToken("gmail", { access_token: "fixture-access" });

    expect(await fs.readdir(store.paths.configDirectory)).toEqual(
      expect.arrayContaining(["client_secret.json", "gmail-token.json"]),
    );
    await expect(fs.stat(store.paths.tokens.calendar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically replaces a token and leaves the previous file intact if rename fails", async () => {
    const home = await temporaryHome();
    const initialStore = createTokenStore({ homeRoot: home });
    await initialStore.writeToken("gmail", { access_token: "old" });

    const failingFs: TokenStoreFileSystem = {
      ...fs,
      rename: async () => {
        const error = new Error("injected rename failure");
        Object.assign(error, { code: "EIO" });
        throw error;
      },
    };
    const failingStore = createTokenStore({ homeRoot: home, fs: failingFs });

    await expect(failingStore.writeToken("gmail", { access_token: "new" })).rejects.toThrow(
      "injected rename failure",
    );
    await expect(initialStore.readToken("gmail")).resolves.toMatchObject({ access_token: "old" });
    expect((await fs.readdir(initialStore.paths.configDirectory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves an existing refresh token when refreshed credentials omit it", async () => {
    const home = await temporaryHome();
    const store = createTokenStore({ homeRoot: home });
    await store.writeToken("calendar", { access_token: "first", refresh_token: "keep-me" });

    const merged = await store.writeToken("calendar", { access_token: "second", expiry_date: 123 });

    expect(merged).toEqual({ access_token: "second", refresh_token: "keep-me", expiry_date: 123 });
    await expect(store.readToken("calendar")).resolves.toEqual(merged);
  });

  it("persists an explicitly rotated refresh token", async () => {
    const home = await temporaryHome();
    const store = createTokenStore({ homeRoot: home });
    await store.writeToken("gmail", { refresh_token: "old" });

    await expect(store.writeToken("gmail", { refresh_token: "rotated" })).resolves.toMatchObject({
      refresh_token: "rotated",
    });
  });

  it("deletes only the selected app token", async () => {
    const home = await temporaryHome();
    const store = createTokenStore({ homeRoot: home });
    await store.writeClientSecret({ installed: { client_id: "fixture-client" } });
    await store.writeToken("gmail", { access_token: "gmail-fixture" });
    await store.writeToken("calendar", { access_token: "calendar-fixture" });

    await store.deleteToken("gmail");

    await expect(fs.stat(store.paths.tokens.gmail)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.readToken("calendar")).resolves.toMatchObject({ access_token: "calendar-fixture" });
    await expect(store.readClientSecret()).resolves.toMatchObject({ installed: { client_id: "fixture-client" } });
  });

  it("rejects invalid JSON without exposing its contents", async () => {
    const home = await temporaryHome();
    const store = createTokenStore({ homeRoot: home });
    await fs.mkdir(store.paths.configDirectory, { recursive: true });
    await fs.writeFile(store.paths.tokens.gmail, "not-json fixture-secret");

    await expect(store.readToken("gmail")).rejects.toThrow(
      `Invalid gmail token JSON at ${store.paths.tokens.gmail}: expected a JSON object.`,
    );
  });

  it.runIf(process.platform !== "win32")("uses private POSIX modes for directories and files", async () => {
    const home = await temporaryHome();
    const store = createTokenStore({ homeRoot: home });
    await store.writeClientSecret({ installed: { client_id: "fixture-client" } });
    await store.writeToken("gmail", { access_token: "fixture-access" });

    const mode = async (path: string) => (await fs.stat(path)).mode & 0o777;
    expect(await mode(store.paths.configDirectory)).toBe(0o700);
    expect(await mode(store.paths.clientSecret)).toBe(0o600);
    expect(await mode(store.paths.tokens.gmail)).toBe(0o600);
  });
});
