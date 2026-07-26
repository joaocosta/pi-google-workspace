import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeAuthError, type WorkspaceAuthService } from "../auth/oauth.js";
import {
  createCalendarClientProvider,
  type CalendarClientFactory,
  type CalendarClientProvider,
} from "./client.js";

export interface CalendarDependencies {
  readonly auth: WorkspaceAuthService;
  readonly clientFactory?: CalendarClientFactory;
  readonly clientProvider?: CalendarClientProvider;
}

function failure(error: unknown) {
  const safe = sanitizeAuthError(
    error,
    "Could not list calendars. Run /gws-login calendar if Calendar authentication has expired.",
  );
  return {
    content: [{ type: "text" as const, text: safe.message }],
    isError: true,
    details: { app: "calendar" as const },
  };
}

export function registerCalendar(pi: ExtensionAPI, dependencies: CalendarDependencies): void {
  const clients =
    dependencies.clientProvider ??
    createCalendarClientProvider(dependencies.auth, dependencies.clientFactory);

  pi.registerTool({
    name: "gws_calendar_list",
    label: "Google Workspace Calendar List",
    description:
      "List one bounded page of calendars available to the authenticated Calendar account. Read-only.",
    promptSnippet: "gws_calendar_list: discover calendar IDs, names, time zones, and access roles",
    promptGuidelines: [
      "Use gws_calendar_list to discover a calendar ID and access role before listing or creating events.",
      "Use gws_calendar_list pageToken only to request the next page explicitly; the tool never auto-pages.",
    ],
    parameters: Type.Object({
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 10 })),
      pageToken: Type.Optional(Type.String({ description: "Google Calendar page token" })),
    }),
    async execute(_toolCallId, params, signal) {
      const maxResults = params.maxResults ?? 10;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 10) {
        return {
          content: [{ type: "text", text: "Calendar maxResults must be an integer from 1 to 10." }],
          isError: true,
          details: { app: "calendar" as const },
        };
      }

      try {
        const client = await clients.getClient();
        const response = await client.calendarList.list(
          {
            maxResults,
            ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
          },
          { signal },
        );
        const calendars = (response.data.items ?? []).map((entry) => ({
          id: entry.id ?? null,
          summary: entry.summary ?? null,
          primary: entry.primary === true,
          timeZone: entry.timeZone ?? null,
          accessRole: entry.accessRole ?? null,
        }));
        const result = {
          calendars,
          ...(response.data.nextPageToken
            ? { nextPageToken: response.data.nextPageToken }
            : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {
            app: "calendar" as const,
            count: calendars.length,
            ...(response.data.nextPageToken
              ? { nextPageToken: response.data.nextPageToken }
              : {}),
          },
        };
      } catch (error) {
        return failure(error);
      }
    },
  });
}
