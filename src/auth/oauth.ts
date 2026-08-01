import { createServer } from "node:http";
import { google } from "googleapis";
import type { WorkspaceAppRegistry } from "./apps.js";
import type { WorkspaceAppKey } from "./paths.js";
import type { JsonObject, OAuthCredentials, TokenStore } from "./token-store.js";

export interface OAuthClient {
  /** Native transport used by Google service constructors; test clients may omit it. */
  readonly googleAuthClient?: InstanceType<typeof google.auth.OAuth2>;
  generateAuthUrl(options: {
    access_type: "offline";
    prompt: "consent";
    scope: readonly string[];
  }): string;
  getToken(code: string): Promise<{ tokens: OAuthCredentials }>;
  setCredentials(credentials: OAuthCredentials): void;
  onTokens(listener: (credentials: OAuthCredentials) => void): void;
}

export type OAuthClientFactory = (
  clientId: string,
  clientSecret: string,
  redirectUri?: string,
) => OAuthClient;

export interface LoopbackSession {
  readonly redirectUri: string;
  waitForCode(): Promise<string>;
  close(): Promise<void>;
}

export type LoopbackServerFactory = (displayName: string) => Promise<LoopbackSession>;

export type LocalAuthState = "present" | "missing" | "invalid";

export interface AuthStatus {
  readonly client: LocalAuthState;
  readonly apps: Readonly<Record<WorkspaceAppKey, LocalAuthState>>;
}

export interface WorkspaceAuthService {
  readonly apps: WorkspaceAppRegistry;
  login(app: WorkspaceAppKey, showAuthorizationUrl: (url: string) => void): Promise<void>;
  getAuthenticatedClient(app: WorkspaceAppKey): Promise<OAuthClient>;
  getStatus(): Promise<AuthStatus>;
  logout(app: WorkspaceAppKey): Promise<void>;
}

class SafeAuthError extends Error {}

interface ClientConfiguration {
  readonly clientId: string;
  readonly clientSecret: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function credentialSection(secret: JsonObject): JsonObject | undefined {
  const candidate = secret["installed"] ?? secret["web"];
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? candidate
    : undefined;
}

function validToken(token: OAuthCredentials): boolean {
  return isNonEmptyString(token.access_token) || isNonEmptyString(token.refresh_token);
}

function normalizeOAuthCredentials(credentials: {
  readonly access_token?: string | null | undefined;
  readonly refresh_token?: string | null | undefined;
  readonly scope?: string | undefined;
  readonly token_type?: string | null | undefined;
  readonly expiry_date?: number | null | undefined;
  readonly id_token?: string | null | undefined;
}): OAuthCredentials {
  return {
    ...(credentials.access_token !== undefined
      ? { access_token: credentials.access_token }
      : {}),
    ...(credentials.refresh_token !== undefined
      ? { refresh_token: credentials.refresh_token }
      : {}),
    ...(credentials.scope !== undefined ? { scope: credentials.scope } : {}),
    ...(credentials.token_type !== undefined ? { token_type: credentials.token_type } : {}),
    ...(credentials.expiry_date !== undefined ? { expiry_date: credentials.expiry_date } : {}),
    ...(credentials.id_token !== undefined ? { id_token: credentials.id_token } : {}),
  };
}

function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function missingClientSecretMessage(path: string): string {
  return [
    `Missing OAuth client credentials at ${path}.`,
    "",
    "Create an OAuth client in Google Cloud Console:",
    "https://console.cloud.google.com/apis/credentials",
    "",
    "Choose Create Credentials → OAuth client ID → Desktop app, download the JSON, and save it at that path.",
    "You may need to enable the Gmail API and Google Calendar API and configure the OAuth consent screen first.",
  ].join("\n");
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Create a localhost-only callback listener. It intentionally has no timeout. */
export const createNodeLoopbackServer: LoopbackServerFactory = async (displayName) => {
  const server = createServer();
  let settleCode!: (code: string) => void;
  let settleError!: (error: Error) => void;
  let settled = false;
  const codePromise = new Promise<string>((resolve, reject) => {
    settleCode = resolve;
    settleError = reject;
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not open the local OAuth callback listener."));
        return;
      }
      resolve(address.port);
    });
  });
  const redirectUri = `http://127.0.0.1:${String(port)}/oauth2callback`;

  server.on("request", (request, response) => {
    if (settled) {
      response.writeHead(409, { "content-type": "text/plain; charset=utf-8" });
      response.end("This authorization callback has already been handled.\n");
      return;
    }
    settled = true;

    const parsed = new URL(request.url ?? "/", redirectUri);
    const code = parsed.searchParams.get("code");
    const callbackError = parsed.searchParams.has("error");
    const ok = isNonEmptyString(code) && !callbackError;
    response.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" });
    response.end(
      ok
        ? `${displayName} authentication complete. You can close this tab.\n`
        : "Authorization failed. Return to Pi and try login again.\n",
    );

    void closeServer(server).finally(() => {
      if (ok) settleCode(code);
      else settleError(new SafeAuthError("The OAuth callback did not contain a usable authorization code."));
    });
  });

  return {
    redirectUri,
    waitForCode: () => codePromise,
    close: () => closeServer(server),
  };
};

export const createGoogleOAuthClient: OAuthClientFactory = (clientId, clientSecret, redirectUri) => {
  const client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  return {
    googleAuthClient: client,
    generateAuthUrl: (options) => client.generateAuthUrl({ ...options, scope: [...options.scope] }),
    async getToken(code) {
      const result = await client.getToken(code);
      return { tokens: normalizeOAuthCredentials(result.tokens) };
    },
    setCredentials: (credentials) => {
      client.setCredentials(credentials);
    },
    onTokens: (listener) => {
      client.on("tokens", (credentials) => {
        listener(normalizeOAuthCredentials(credentials));
      });
    },
  };
};

export interface WorkspaceAuthOptions {
  readonly store: TokenStore;
  readonly apps: WorkspaceAppRegistry;
  readonly oauthClientFactory?: OAuthClientFactory;
  readonly loopbackServerFactory?: LoopbackServerFactory;
}

export function sanitizeAuthError(error: unknown, fallback: string): Error {
  return error instanceof SafeAuthError ? error : new SafeAuthError(fallback);
}

export function createWorkspaceAuth(options: WorkspaceAuthOptions): WorkspaceAuthService {
  const { store, apps } = options;
  const oauthClientFactory = options.oauthClientFactory ?? createGoogleOAuthClient;
  const loopbackServerFactory = options.loopbackServerFactory ?? createNodeLoopbackServer;
  let loginActive = false;

  async function readClientConfiguration(): Promise<ClientConfiguration> {
    let secret: JsonObject;
    try {
      secret = await store.readClientSecret();
    } catch (error) {
      if (missingFile(error)) {
        throw new SafeAuthError(missingClientSecretMessage(store.paths.clientSecret));
      }
      throw new SafeAuthError(`OAuth client credentials at ${store.paths.clientSecret} are invalid or unreadable.`);
    }

    const config = credentialSection(secret);
    const clientId = config?.["client_id"];
    const clientSecret = config?.["client_secret"];
    if (!isNonEmptyString(clientId) || !isNonEmptyString(clientSecret)) {
      throw new SafeAuthError(`OAuth client credentials at ${store.paths.clientSecret} are invalid.`);
    }
    return { clientId, clientSecret };
  }

  async function tokenState(app: WorkspaceAppKey): Promise<LocalAuthState> {
    try {
      return validToken(await store.readToken(app)) ? "present" : "invalid";
    } catch (error) {
      return missingFile(error) ? "missing" : "invalid";
    }
  }

  return {
    apps,

    async login(app, showAuthorizationUrl) {
      if (loginActive) throw new SafeAuthError("Another Google Workspace login is already in progress.");
      loginActive = true;
      let loopback: LoopbackSession | undefined;
      try {
        const config = await readClientConfiguration();
        loopback = await loopbackServerFactory(apps[app].displayName);
        const client = oauthClientFactory(config.clientId, config.clientSecret, loopback.redirectUri);
        const authorizationUrl = client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: apps[app].scopes,
        });
        showAuthorizationUrl(authorizationUrl);

        let code: string;
        try {
          code = await loopback.waitForCode();
        } catch (error) {
          throw sanitizeAuthError(error, `Could not complete ${apps[app].displayName} authorization.`);
        }

        let credentials: OAuthCredentials;
        try {
          credentials = (await client.getToken(code)).tokens;
        } catch (error) {
          throw sanitizeAuthError(error, `Could not exchange the ${apps[app].displayName} authorization response.`);
        }
        if (!validToken(credentials)) {
          throw new SafeAuthError(`${apps[app].displayName} authorization returned invalid credentials.`);
        }
        await store.writeToken(app, credentials);
      } finally {
        await loopback?.close().catch(() => undefined);
        loginActive = false;
      }
    },

    async getAuthenticatedClient(app) {
      const config = await readClientConfiguration();
      let credentials: OAuthCredentials;
      try {
        credentials = await store.readToken(app);
      } catch {
        throw new SafeAuthError(`${apps[app].displayName} is not authenticated. Run /gws-login ${app}.`);
      }
      if (!validToken(credentials)) {
        throw new SafeAuthError(`${apps[app].displayName} authentication is invalid. Run /gws-login ${app}.`);
      }

      const client = oauthClientFactory(config.clientId, config.clientSecret);
      client.setCredentials(credentials);
      client.onTokens((rotated) => {
        void store.writeToken(app, rotated).catch(() => undefined);
      });
      return client;
    },

    async getStatus() {
      let client: LocalAuthState;
      try {
        await readClientConfiguration();
        client = "present";
      } catch (error) {
        client = missingFile(error) ? "missing" : "invalid";
        if (error instanceof SafeAuthError && error.message.startsWith("Missing ")) client = "missing";
      }
      const [gmail, calendar] = await Promise.all([tokenState("gmail"), tokenState("calendar")]);
      return { client, apps: { gmail, calendar } };
    },

    logout: (app) => store.deleteToken(app),
  };
}
