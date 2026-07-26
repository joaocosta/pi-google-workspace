import * as nodeFs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { resolveOAuthPaths, type OAuthPaths, type WorkspaceAppKey } from "./paths.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue | undefined };

export interface OAuthCredentials extends JsonObject {
  access_token?: string;
  refresh_token?: string | null;
  scope?: string;
  token_type?: string;
  expiry_date?: number;
}

export type TokenStoreFileSystem = Pick<
  typeof nodeFs,
  "chmod" | "mkdir" | "readFile" | "rename" | "rm" | "writeFile"
>;

export interface TokenStoreOptions {
  readonly homeRoot?: string;
  readonly fs?: TokenStoreFileSystem;
}

export interface TokenStore {
  readonly paths: OAuthPaths;
  readClientSecret(): Promise<JsonObject>;
  writeClientSecret(secret: JsonObject): Promise<void>;
  readToken(app: WorkspaceAppKey): Promise<OAuthCredentials>;
  writeToken(app: WorkspaceAppKey, credentials: OAuthCredentials): Promise<OAuthCredentials>;
  deleteToken(app: WorkspaceAppKey): Promise<void>;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedMode(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

async function secureMode(fs: TokenStoreFileSystem, path: string, mode: number): Promise<void> {
  try {
    await fs.chmod(path, mode);
  } catch (error) {
    if (!unsupportedMode(error)) throw error;
  }
}

async function ensureConfigDirectory(fs: TokenStoreFileSystem, path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await secureMode(fs, path, 0o700);
}

async function readJsonObject(
  fs: TokenStoreFileSystem,
  path: string,
  description: string,
): Promise<JsonObject> {
  await secureMode(fs, path, 0o600);
  const serialized = await fs.readFile(path, "utf8");

  try {
    const value: unknown = JSON.parse(serialized);
    if (!isJsonObject(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error(`Invalid ${description} JSON at ${path}: expected a JSON object.`);
  }
}

async function writeJsonAtomic(
  fs: TokenStoreFileSystem,
  directory: string,
  destination: string,
  value: JsonObject,
): Promise<void> {
  await ensureConfigDirectory(fs, directory);
  const temporary = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await secureMode(fs, temporary, 0o600);
    await fs.rename(temporary, destination);
    await secureMode(fs, destination, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function createTokenStore(options: TokenStoreOptions = {}): TokenStore {
  const fs = options.fs ?? nodeFs;
  const paths = resolveOAuthPaths(options.homeRoot);

  return {
    paths,

    async readClientSecret(): Promise<JsonObject> {
      await ensureConfigDirectory(fs, paths.configDirectory);
      return readJsonObject(fs, paths.clientSecret, "OAuth client secret");
    },

    async writeClientSecret(secret: JsonObject): Promise<void> {
      await writeJsonAtomic(fs, paths.configDirectory, paths.clientSecret, secret);
    },

    async readToken(app: WorkspaceAppKey): Promise<OAuthCredentials> {
      await ensureConfigDirectory(fs, paths.configDirectory);
      return (await readJsonObject(fs, paths.tokens[app], `${app} token`)) as OAuthCredentials;
    },

    async writeToken(app: WorkspaceAppKey, credentials: OAuthCredentials): Promise<OAuthCredentials> {
      let existing: OAuthCredentials = {};
      try {
        existing = await this.readToken(app);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
      }

      const merged: OAuthCredentials = { ...existing, ...credentials };
      if (!("refresh_token" in credentials) && "refresh_token" in existing) {
        merged.refresh_token = existing.refresh_token;
      }
      await writeJsonAtomic(fs, paths.configDirectory, paths.tokens[app], merged);
      return merged;
    },

    async deleteToken(app: WorkspaceAppKey): Promise<void> {
      await fs.rm(paths.tokens[app], { force: true });
    },
  };
}
