import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { sanitizeAuthError, type WorkspaceAuthService } from "../auth/oauth.js";
import { confirmMutation } from "../extension/confirmation.js";
import {
  createCalendarClientProvider,
  type CalendarClientFactory,
  type CalendarClientProvider,
  type CalendarRequestOptions,
} from "./client.js";
import {
  buildCalendarEvent,
  CalendarInputError,
  normalizeCalendarEvent,
  normalizeEventTime,
  resolveEventRange,
  type CalendarTimeDependencies,
} from "./events.js";

export const CALENDAR_TOOL_NAMES = {
  list: "gws_calendar_list",
  listEvents: "gws_calendar_list_events",
  createEvent: "gws_calendar_create_event",
} as const;

export interface CalendarDependencies {
  readonly auth: WorkspaceAuthService;
  readonly clientFactory?: CalendarClientFactory;
  readonly clientProvider?: CalendarClientProvider;
  readonly time?: CalendarTimeDependencies;
}

function requestOptions(signal: AbortSignal | undefined): CalendarRequestOptions {
  return { signal };
}

function failure(error: unknown, action = "list calendars", calendarId?: string) {
  const fallback = calendarId
    ? `Could not ${action} on calendar ${calendarId}. Run /gws-login calendar if Calendar authentication has expired or choose a writable calendar.`
    : `Could not ${action}. Run /gws-login calendar if Calendar authentication has expired.`;
  const safe = sanitizeAuthError(error, fallback);
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
    name: CALENDAR_TOOL_NAMES.list,
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
          requestOptions(signal),
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
    name: CALENDAR_TOOL_NAMES.listEvents,
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
            ...(params.timeMin === undefined ? {} : { timeMin: params.timeMin }),
            ...(params.timeMax === undefined ? {} : { timeMax: params.timeMax }),
            ...(params.timeZone === undefined ? {} : { timeZone: params.timeZone }),
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
          requestOptions(signal),
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

  pi.registerTool({
    name: CALENDAR_TOOL_NAMES.createEvent,
    label: "Google Workspace Calendar Create Event",
    description:
      "Create one core-field timed or all-day Calendar event after explicit caller intent and interactive confirmation.",
    promptSnippet:
      "gws_calendar_create_event: create a confirmed, timezone-safe Calendar event",
    promptGuidelines: [
      "Before using gws_calendar_create_event, show the target calendar and complete event details unless the user already explicitly provided them.",
      "Timed events require offset-free local start/end values and use an explicit IANA timeZone or the host IANA zone.",
      "All-day endDate is exclusive. Headless use requires explicit caller consent.",
    ],
    parameters: Type.Object({
      calendarId: Type.Optional(Type.String({ description: "Calendar ID; defaults to primary" })),
      summary: Type.String({ minLength: 1, description: "Non-empty event title" }),
      description: Type.Optional(Type.String()),
      location: Type.Optional(Type.String()),
      timing: Type.Union([
        Type.Object({
          kind: Type.Literal("timed"),
          start: Type.String({ description: "Offset-free local start date-time" }),
          end: Type.String({ description: "Offset-free local end date-time" }),
          timeZone: Type.Optional(Type.String({ description: "IANA time zone" })),
        }),
        Type.Object({
          kind: Type.Literal("allDay"),
          startDate: Type.String({ description: "ISO start date" }),
          endDate: Type.String({ description: "Exclusive ISO end date" }),
        }),
      ]),
    }),
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const calendarId = params.calendarId?.trim() || "primary";

      try {
        const built = buildCalendarEvent(
          toolCallId,
          {
            summary: params.summary,
            ...(params.description === undefined ? {} : { description: params.description }),
            ...(params.location === undefined ? {} : { location: params.location }),
            timing: params.timing,
          },
          dependencies.time,
        );
        const client = await clients.getClient();

        let calendarName = calendarId;
        let resolvedCalendarId = calendarId;
        try {
          const metadata = await client.calendarList.get({ calendarId }, requestOptions(signal));
          calendarName = metadata.data.summary || metadata.data.id || calendarId;
          resolvedCalendarId = metadata.data.id || calendarId;
          if (
            metadata.data.accessRole === "reader" ||
            metadata.data.accessRole === "freeBusyReader"
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Calendar ${calendarName} (${resolvedCalendarId}) is read-only. Choose a writable calendar.`,
                },
              ],
              isError: true,
              details: { app: "calendar" as const, calendarId },
            };
          }
        } catch (error) {
          // Metadata improves confirmation but is not authoritative; insert reports access failures.
          if (signal?.aborted) {
            throw error;
          }
        }

        const description = built.requestBody.description ?? "(none)";
        const location = built.requestBody.location ?? "(none)";
        const timing =
          built.normalizedStart.kind === "allDay"
            ? [
                `All-day start: ${built.normalizedStart.date}`,
                `Exclusive end: ${built.normalizedEnd.kind === "allDay" ? built.normalizedEnd.date : "invalid"}`,
              ]
            : [
                `Start: ${String(built.normalizedStart.dateTime)}`,
                `End: ${String(built.normalizedEnd.kind === "dateTime" ? built.normalizedEnd.dateTime : "invalid")}`,
                `Time zone: ${String(built.normalizedStart.timeZone)}`,
              ];
        const preview = [
          `Calendar: ${calendarName} (${resolvedCalendarId})`,
          `Summary: ${String(built.requestBody.summary)}`,
          ...timing,
          `Description: ${description}`,
          `Location: ${location}`,
        ].join("\n");

        if (!(await confirmMutation(ctx, "Confirm Calendar event", preview))) {
          return {
            content: [{ type: "text", text: "Calendar event creation cancelled." }],
            details: { app: "calendar" as const, calendarId, cancelled: true },
          };
        }

        let event;
        let idempotent = false;
        try {
          const response = await client.events.insert(
            { calendarId, requestBody: built.requestBody },
            requestOptions(signal),
          );
          event = response.data;
        } catch (error) {
          const candidate = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
          const status = candidate.response?.status ?? candidate.status ?? candidate.code;
          if (Number(status) !== 409) {
            return failure(error, "create an event", calendarId);
          }

          const eventId = built.requestBody.id;
          if (!eventId) {
            throw new Error("Calendar event creation did not produce a deterministic event ID.", {
              cause: error,
            });
          }
          try {
            const response = await client.events.get({ calendarId, eventId }, requestOptions(signal));
            if (response.data.id !== eventId) {
              throw new Error("The conflicting event did not match the deterministic event ID.", {
                cause: error,
              });
            }
            event = response.data;
            idempotent = true;
          } catch (recoveryError) {
            return failure(recoveryError, "recover a conflicting event", calendarId);
          }
        }

        const result = {
          calendarId,
          id: event.id ?? built.requestBody.id ?? null,
          summary: event.summary ?? built.requestBody.summary ?? null,
          start: normalizeEventTime(event.start ?? built.requestBody.start),
          end: normalizeEventTime(event.end ?? built.requestBody.end),
          ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
          ...(idempotent ? { idempotent: true } : {}),
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: {
            app: "calendar" as const,
            calendarId,
            eventId: result.id,
            ...(idempotent ? { idempotent: true } : {}),
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
        return failure(error, "create an event", calendarId);
      }
    },
  });
}
