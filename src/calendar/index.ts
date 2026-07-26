import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeAuthError, type WorkspaceAuthService } from "../auth/oauth.js";
import {
  createCalendarClientProvider,
  type CalendarClientFactory,
  type CalendarClientProvider,
} from "./client.js";
import {
  CalendarInputError,
  normalizeCalendarEvent,
  resolveEventRange,
  type CalendarTimeDependencies,
} from "./events.js";

export interface CalendarDependencies {
  readonly auth: WorkspaceAuthService;
  readonly clientFactory?: CalendarClientFactory;
  readonly clientProvider?: CalendarClientProvider;
  readonly time?: CalendarTimeDependencies;
}

function failure(error: unknown, action = "list calendars") {
  const safe = sanitizeAuthError(
    error,
    `Could not ${action}. Run /gws-login calendar if Calendar authentication has expired.`,
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

  pi.registerTool({
    name: "gws_calendar_list_events",
    label: "Google Workspace Calendar Event List",
    description:
      "List one bounded page of expanded, non-cancelled Calendar events in ascending start order. Read-only.",
    promptSnippet:
      "gws_calendar_list_events: list upcoming Calendar events with optional local range and query",
    promptGuidelines: [
      "Use gws_calendar_list_events for one explicit event page; pageToken requests the next page and never auto-pages.",
      "Pass gws_calendar_list_events offset-free local bounds with an IANA timeZone; omitted bounds default to the next seven days in the host zone.",
    ],
    parameters: Type.Object({
      calendarId: Type.Optional(Type.String({ description: "Calendar ID; defaults to primary" })),
      timeMin: Type.Optional(
        Type.String({ description: "Offset-free local lower bound, for example 2026-04-05T09:30:00" }),
      ),
      timeMax: Type.Optional(
        Type.String({ description: "Offset-free local upper bound, for example 2026-04-05T17:30:00" }),
      ),
      timeZone: Type.Optional(Type.String({ description: "IANA zone for local bounds" })),
      query: Type.Optional(Type.String({ description: "Google Calendar free-text query" })),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 10 })),
      pageToken: Type.Optional(Type.String({ description: "Google Calendar page token" })),
    }),
    async execute(_toolCallId, params, signal) {
      const calendarId = params.calendarId ?? "primary";
      const maxResults = params.maxResults ?? 10;
      if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 20) {
        return {
          content: [{ type: "text", text: "Calendar event maxResults must be an integer from 1 to 20." }],
          isError: true,
          details: { app: "calendar" as const },
        };
      }

      try {
        const range = resolveEventRange(
          {
            timeMin: params.timeMin,
            timeMax: params.timeMax,
            timeZone: params.timeZone,
          },
          dependencies.time,
        );
        const client = await clients.getClient();
        const response = await client.events.list(
          {
            calendarId,
            maxResults,
            singleEvents: true,
            orderBy: "startTime",
            showDeleted: false,
            ...(range.timeMin === undefined ? {} : { timeMin: range.timeMin }),
            ...(range.timeMax === undefined ? {} : { timeMax: range.timeMax }),
            ...(params.query === undefined ? {} : { q: params.query }),
            ...(params.pageToken === undefined ? {} : { pageToken: params.pageToken }),
          },
          { signal },
        );
        const events = (response.data.items ?? []).map((event) =>
          normalizeCalendarEvent(calendarId, event),
        );
        const result = {
          events,
          ...(response.data.nextPageToken
            ? { nextPageToken: response.data.nextPageToken }
            : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {
            app: "calendar" as const,
            calendarId,
            count: events.length,
            ...(response.data.nextPageToken
              ? { nextPageToken: response.data.nextPageToken }
              : {}),
          },
        };
      } catch (error) {
        if (error instanceof CalendarInputError) {
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
            details: { app: "calendar" as const },
          };
        }
        return failure(error, "list calendar events");
      }
    },
  });
}
