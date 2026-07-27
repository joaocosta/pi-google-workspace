import { homedir } from "node:os";
import { join } from "node:path";

export const WORKSPACE_APP_KEYS = ["gmail", "calendar"] as const;
export type WorkspaceAppKey = (typeof WORKSPACE_APP_KEYS)[number];

export interface AppStorageDefinition {
  readonly key: WorkspaceAppKey;
  readonly tokenFileName: string;
}

export const APP_STORAGE_DEFINITIONS: Readonly<Record<WorkspaceAppKey, AppStorageDefinition>> = {
  gmail: { key: "gmail", tokenFileName: "gmail-token.json" },
  calendar: { key: "calendar", tokenFileName: "calendar-token.json" },
};

export interface OAuthPaths {
  readonly configDirectory: string;
  readonly clientSecret: string;
  readonly tokens: Readonly<Record<WorkspaceAppKey, string>>;
}

/** Resolve OAuth paths beneath a supplied home root without touching the filesystem. */
export function resolveOAuthPaths(homeRoot: string = homedir()): OAuthPaths {
  const configDirectory = join(homeRoot, ".pi", "agent", "gws-oauth");
  const tokens = Object.fromEntries(
    WORKSPACE_APP_KEYS.map((key) => [key, join(configDirectory, APP_STORAGE_DEFINITIONS[key].tokenFileName)]),
  ) as Record<WorkspaceAppKey, string>;

  return {
    configDirectory,
    clientSecret: join(configDirectory, "client_secret.json"),
    tokens,
  };
}
