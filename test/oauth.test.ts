import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CALENDAR_SCOPES, GMAIL_SCOPES, createWorkspaceAppRegistry } from "../src/auth/apps.js";
import {
  createWorkspaceAuth,
  type LoopbackSession,
  type OAuthClient,
} from "../src/auth/oauth.js";
import { createTokenStore, type OAuthCredentials } from "../src/auth/token-store.js";

const roots: string[] = [];

async function fixtureStore() {
  const home = await fs.mkdtemp(join(tmpdir(), "pi-gws-auth-"));
  roots.push(home);
  const store = createTokenStore({ homeRoot: home });
  await store.writeClientSecret({ installed: { client_id: "fixture-client", client_secret: "fixture-secret" } });
  return store;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function fakeClient(tokens: OAuthCredentials = { access_token: "new-access", refresh_token: "new-refresh" }) {
  let tokenListener: ((credentials: OAuthCredentials) => void) | undefined;
  const client: OAuthClient = {
    generateAuthUrl: vi.fn(() => "https://accounts.example/authorize?safe=1"),
    getToken: vi.fn(async () => ({ tokens })),
    setCredentials: vi.fn(),
    onTokens: vi.fn((listener) => {
      tokenListener = listener;
    }),
  };
  return { client, emitTokens: (credentials: OAuthCredentials) => tokenListener?.(credentials) };
}

function loopback(code: Promise<string> | string = "fixture-code") {
  const session: LoopbackSession = {
    redirectUri: "http://127.0.0.1:43210/oauth2callback",
    waitForCode: vi.fn(() => Promise.resolve(code)),
    close: vi.fn(async () => undefined),
  };
  return session;
}

describe("workspace app authorization profiles", () => {
  it("uses exact independent scopes and token paths", async () => {
    const store = await fixtureStore();
    const apps = createWorkspaceAppRegistry(store);

    expect(apps.gmail).toMatchObject({ scopes: GMAIL_SCOPES, tokenPath: store.paths.tokens.gmail });
    expect(apps.calendar).toMatchObject({ scopes: CALENDAR_SCOPES, tokenPath: store.paths.tokens.calendar });
    expect(apps.gmail.scopes).toEqual(["https://www.googleapis.com/auth/gmail.modify"]);
    expect(apps.calendar.scopes).toEqual([
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
  });
});

describe("workspace OAuth service", () => {
  it("completes a selected-app callback, closes it, and writes only that token", async () => {
    const store = await fixtureStore();
    await store.writeToken("calendar", { access_token: "calendar-stays" });
    const apps = createWorkspaceAppRegistry(store);
    const { client } = fakeClient();
    const factory = vi.fn(() => client);
    const callback = loopback();
    const auth = createWorkspaceAuth({ store, apps, oauthClientFactory: factory, loopbackServerFactory: async () => callback });
    const showUrl = vi.fn();

    await auth.login("gmail", showUrl);

    expect(factory).toHaveBeenCalledWith("fixture-client", "fixture-secret", callback.redirectUri);
    expect(client.generateAuthUrl).toHaveBeenCalledWith({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
    });
    expect(client.getToken).toHaveBeenCalledWith("fixture-code");
    expect(showUrl).toHaveBeenCalledWith("https://accounts.example/authorize?safe=1");
    expect(callback.close).toHaveBeenCalled();
    await expect(store.readToken("gmail")).resolves.toMatchObject({ refresh_token: "new-refresh" });
    await expect(store.readToken("calendar")).resolves.toMatchObject({ access_token: "calendar-stays" });
  });

  it("closes callback errors and does not expose their secret-bearing text", async () => {
    const store = await fixtureStore();
    const callback = loopback();
    callback.waitForCode = vi.fn(async () => {
      throw new Error("code=private-code&access_token=private-token");
    });
    const auth = createWorkspaceAuth({
      store,
      apps: createWorkspaceAppRegistry(store),
      oauthClientFactory: () => fakeClient().client,
      loopbackServerFactory: async () => callback,
    });

    await expect(auth.login("calendar", vi.fn())).rejects.toThrow("Could not complete Calendar authorization.");
    expect(callback.close).toHaveBeenCalled();
    await expect(fs.readFile(store.paths.tokens.calendar, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a concurrent login while the first callback is pending", async () => {
    const store = await fixtureStore();
    let release!: (code: string) => void;
    const pendingCode = new Promise<string>((resolve) => { release = resolve; });
    const callback = loopback(pendingCode);
    const auth = createWorkspaceAuth({
      store,
      apps: createWorkspaceAppRegistry(store),
      oauthClientFactory: () => fakeClient().client,
      loopbackServerFactory: async () => callback,
    });

    const first = auth.login("gmail", vi.fn());
    await vi.waitFor(() => { expect(callback.waitForCode).toHaveBeenCalled(); });
    await expect(auth.login("calendar", vi.fn())).rejects.toThrow("Another Google Workspace login is already in progress.");
    release("fixture-code");
    await first;
  });

  it("accepts web credentials and gives safe recovery for missing or invalid local data", async () => {
    const store = await fixtureStore();
    const apps = createWorkspaceAppRegistry(store);
    await fs.rm(store.paths.clientSecret);
    await expect(createWorkspaceAuth({ store, apps }).getAuthenticatedClient("gmail")).rejects.toThrow(
      `Missing OAuth client credentials at ${store.paths.clientSecret}.`,
    );
    await expect(createWorkspaceAuth({ store, apps }).getAuthenticatedClient("gmail")).rejects.toThrow(
      "Create Credentials → OAuth client ID → Desktop app",
    );

    await store.writeClientSecret({ web: { client_id: "web-client", client_secret: "web-secret" } });
    const { client } = fakeClient();
    const factory = vi.fn(() => client);
    const auth = createWorkspaceAuth({ store, apps, oauthClientFactory: factory });

    await expect(auth.getAuthenticatedClient("gmail")).rejects.toThrow("Run /gws-login gmail.");
    await store.writeToken("gmail", {});
    await expect(auth.getAuthenticatedClient("gmail")).rejects.toThrow("authentication is invalid");
    await fs.writeFile(store.paths.tokens.gmail, "not-json private-token-material");
    await expect(auth.getAuthenticatedClient("gmail")).rejects.toThrow(
      "Gmail is not authenticated. Run /gws-login gmail.",
    );
    await store.deleteToken("gmail");
    await store.writeToken("gmail", { refresh_token: "fixture-refresh" });
    await auth.getAuthenticatedClient("gmail");
    expect(factory).toHaveBeenCalledWith("web-client", "web-secret");

    await store.writeClientSecret({ installed: { client_id: "fixture-client" } });
    await expect(auth.getAuthenticatedClient("gmail")).rejects.toThrow("OAuth client credentials");
  });

  it("persists token rotation while preserving an omitted refresh token", async () => {
    const store = await fixtureStore();
    await store.writeToken("gmail", { access_token: "old-access", refresh_token: "keep-refresh" });
    const fake = fakeClient();
    const auth = createWorkspaceAuth({
      store,
      apps: createWorkspaceAppRegistry(store),
      oauthClientFactory: (() => fake.client),
    });

    const client = await auth.getAuthenticatedClient("gmail");
    expect(client.setCredentials).toHaveBeenCalledWith(expect.objectContaining({ refresh_token: "keep-refresh" }));
    fake.emitTokens({ access_token: "rotated-access" });
    await vi.waitFor(async () => {
      await expect(store.readToken("gmail")).resolves.toMatchObject({
        access_token: "rotated-access",
        refresh_token: "keep-refresh",
      });
    });
  });

  it("reports local status without returning credential values", async () => {
    const store = await fixtureStore();
    await store.writeToken("gmail", { access_token: "must-not-appear", refresh_token: "also-secret" });
    const auth = createWorkspaceAuth({ store, apps: createWorkspaceAppRegistry(store) });

    const status = await auth.getStatus();

    expect(status).toEqual({ client: "present", apps: { gmail: "present", calendar: "missing" } });
    expect(JSON.stringify(status)).not.toContain("must-not-appear");
    expect(JSON.stringify(status)).not.toContain("also-secret");
  });
});
