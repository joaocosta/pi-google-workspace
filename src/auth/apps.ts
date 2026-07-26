import type { WorkspaceAppKey } from "./paths.js";
import type { TokenStore } from "./token-store.js";

export interface WorkspaceAppDefinition {
  readonly key: WorkspaceAppKey;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly tokenPath: string;
}

export type WorkspaceAppRegistry = Readonly<Record<WorkspaceAppKey, WorkspaceAppDefinition>>;

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"] as const;
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

/** Build authorization profiles against the token store used by this extension instance. */
export function createWorkspaceAppRegistry(store: TokenStore): WorkspaceAppRegistry {
  return {
    gmail: {
      key: "gmail",
      displayName: "Gmail",
      scopes: GMAIL_SCOPES,
      tokenPath: store.paths.tokens.gmail,
    },
    calendar: {
      key: "calendar",
      displayName: "Calendar",
      scopes: CALENDAR_SCOPES,
      tokenPath: store.paths.tokens.calendar,
    },
  };
}
