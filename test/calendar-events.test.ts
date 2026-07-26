import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import type { CalendarClient, CalendarClientProvider } from "../src/calendar/client.js";
import {
  CalendarInputError,
  localDateTimeToRfc3339,
  resolveEventRange,
} from "../src/calendar/events.js";
import { registerCalendar } from "../src/calendar/index.js";

type ToolOptions = {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: Function;
};

function authService(): WorkspaceAuthService {
  return {
    apps: createWorkspaceAppRegistry(createTokenStore({ homeRoot: "/synthetic-home" })),
    login: vi.fn(),
    getAuthenticatedClient: vi.fn(),
    getStatus: vi.fn(),
    logout: vi.fn(),
  };
}

function mockClient(eventData: object = { items: [] }): CalendarClient {
  return {
    calendarList: {
      list: vi.fn(async () => ({ data: { items: [] } })),
      get: vi.fn(async () => ({ data: {} })),
    },
    events: {
      list: vi.fn(async () => ({ data: eventData })),
      insert: vi.fn(async () => ({ data: {} })),
      get: vi.fn(async () => ({ data: {} })),
    },
  };
}

function register(
  clientProvider: CalendarClientProvider,
  time: { now?: () => Date; hostTimeZone?: () => string | undefined } = {},
) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerCalendar(pi as never, { auth: authService(), clientProvider, time });
  return tools.get("gws_calendar_list_events")!;
}

async function execute(tool: ToolOptions, params: object, signal?: AbortSignal) {
  return tool.execute("synthetic-call", params, signal, undefined, { hasUI: false });
}

describe("Calendar event time ranges", () => {
  it("uses an exact seven-day default window in the injected host zone across DST", () => {
    const range = resolveEventRange(
      {},
      {
        now: () => new Date("2026-03-28T12:00:00.000Z"),
        hostTimeZone: () => "Europe/Lisbon",
      },
    );

    expect(range).toEqual({
      timeZone: "Europe/Lisbon",
      timeMin: "2026-03-28T12:00:00.000+00:00",
      timeMax: "2026-04-04T13:00:00.000+01:00",
    });
    expect(Date.parse(range.timeMax!) - Date.parse(range.timeMin!)).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("converts independent and paired local bounds with explicit IANA DST semantics", () => {
    expect(
      resolveEventRange(
        { timeMin: "2026-03-28T12:00:00", timeZone: "Europe/Lisbon" },
        { hostTimeZone: () => "Ignored/Zone" },
      ),
    ).toEqual({
      timeZone: "Europe/Lisbon",
      timeMin: "2026-03-28T12:00:00.000+00:00",
    });
    expect(
      resolveEventRange(
        {
          timeMin: "2026-03-28T12:00:00",
          timeMax: "2026-03-30T12:00:00",
          timeZone: "Europe/Lisbon",
        },
      ),
    ).toEqual({
      timeZone: "Europe/Lisbon",
      timeMin: "2026-03-28T12:00:00.000+00:00",
      timeMax: "2026-03-30T12:00:00.000+01:00",
    });
    expect(
      resolveEventRange(
        { timeMax: "2026-11-02T08:00", timeZone: "America/New_York" },
      ),
    ).toEqual({
      timeZone: "America/New_York",
      timeMax: "2026-11-02T08:00:00.000-05:00",
    });
  });

  it("rejects offsets, invalid dates, DST gaps, reversed ranges, and invalid host zones", () => {
    for (const value of [
      "2026-01-01T10:00:00Z",
      "2026-01-01T10:00:00+01:00",
      "2026-02-30T10:00:00",
      "2026-03-29T01:30:00",
    ]) {
      expect(() => localDateTimeToRfc3339(value, "Europe/Lisbon")).toThrow(CalendarInputError);
    }
    expect(() =>
      resolveEventRange({
        timeMin: "2026-04-02T10:00",
        timeMax: "2026-04-02T09:00",
        timeZone: "Europe/Lisbon",
      }),
    ).toThrow("later than timeMin");
    expect(() =>
      resolveEventRange({}, { hostTimeZone: () => "Not/A_Real_Zone" }),
    ).toThrow("valid IANA zone");
    expect(() => resolveEventRange({}, { hostTimeZone: () => undefined })).toThrow(
      "valid IANA zone",
    );
  });
});

describe("Calendar event listing", () => {
  const fixedTime = {
    now: () => new Date("2026-06-01T10:15:00.000Z"),
    hostTimeZone: () => "Europe/Lisbon",
  };

  it("registers the exact prefixed tool with explicit paging and local-time guidance", () => {
    const tool = register({ getClient: vi.fn(async () => mockClient()) }, fixedTime);
    const prompt = `${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`;
    expect(prompt).toContain("gws_calendar_list_events");
    expect(prompt).toContain("offset-free local bounds");
    expect(prompt).toContain("never auto-pages");
  });

  it("defaults to primary, ten results, and one seven-day request with expansion flags", async () => {
    const client = mockClient();
    const tool = register({ getClient: vi.fn(async () => client) }, fixedTime);
    const signal = new AbortController().signal;

    await execute(tool, {}, signal);

    expect(client.events.list).toHaveBeenCalledTimes(1);
    expect(client.events.list).toHaveBeenCalledWith(
      {
        calendarId: "primary",
        maxResults: 10,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        timeMin: "2026-06-01T11:15:00.000+01:00",
        timeMax: "2026-06-08T11:15:00.000+01:00",
      },
      { signal },
    );
  });

  it("forwards a selected calendar, one bound, query, page token, and the 20-item cap", async () => {
    const client = mockClient({ items: [], nextPageToken: "next-events-page" });
    const tool = register({ getClient: vi.fn(async () => client) }, fixedTime);

    const result = await execute(tool, {
      calendarId: "team@example.test",
      timeMax: "2026-06-03T18:00:00",
      timeZone: "America/New_York",
      query: "synthetic planning",
      maxResults: 20,
      pageToken: "current-events-page",
    });

    expect(client.events.list).toHaveBeenCalledTimes(1);
    expect(client.events.list).toHaveBeenCalledWith(
      {
        calendarId: "team@example.test",
        maxResults: 20,
        singleEvents: true,
        orderBy: "startTime",
        showDeleted: false,
        timeMax: "2026-06-03T18:00:00.000-04:00",
        q: "synthetic planning",
        pageToken: "current-events-page",
      },
      { signal: undefined },
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      events: [],
      nextPageToken: "next-events-page",
    });
    expect(result.details).toEqual({
      app: "calendar",
      calendarId: "team@example.test",
      count: 0,
      nextPageToken: "next-events-page",
    });
  });

  it("normalizes timed, all-day, and recurring occurrence context", async () => {
    const client = mockClient({
      items: [
        {
          id: "timed-event",
          summary: "Synthetic planning",
          description: "Synthetic description",
          location: "Synthetic room",
          start: { dateTime: "2026-06-02T09:00:00+01:00", timeZone: "Europe/Lisbon" },
          end: { dateTime: "2026-06-02T10:00:00+01:00", timeZone: "Europe/Lisbon" },
          status: "confirmed",
          recurringEventId: "series-id",
          originalStartTime: {
            dateTime: "2026-06-02T09:00:00+01:00",
            timeZone: "Europe/Lisbon",
          },
          htmlLink: "https://calendar.example.test/timed-event",
        },
        {
          id: "all-day-event",
          summary: "Synthetic holiday",
          start: { date: "2026-06-04" },
          end: { date: "2026-06-05" },
          status: "tentative",
        },
        {},
      ],
    });
    const tool = register({ getClient: vi.fn(async () => client) }, fixedTime);

    const result = await execute(tool, {});

    expect(JSON.parse(result.content[0].text).events).toEqual([
      {
        calendarId: "primary",
        id: "timed-event",
        summary: "Synthetic planning",
        description: "Synthetic description",
        location: "Synthetic room",
        start: {
          kind: "dateTime",
          dateTime: "2026-06-02T09:00:00+01:00",
          timeZone: "Europe/Lisbon",
        },
        end: {
          kind: "dateTime",
          dateTime: "2026-06-02T10:00:00+01:00",
          timeZone: "Europe/Lisbon",
        },
        status: "confirmed",
        recurringEventId: "series-id",
        originalStartTime: {
          kind: "dateTime",
          dateTime: "2026-06-02T09:00:00+01:00",
          timeZone: "Europe/Lisbon",
        },
        htmlLink: "https://calendar.example.test/timed-event",
      },
      {
        calendarId: "primary",
        id: "all-day-event",
        summary: "Synthetic holiday",
        start: { kind: "allDay", date: "2026-06-04", timeZone: null },
        end: { kind: "allDay", date: "2026-06-05", timeZone: null },
        status: "tentative",
      },
      {
        calendarId: "primary",
        id: null,
        summary: null,
        start: { kind: "dateTime", dateTime: null, timeZone: null },
        end: { kind: "dateTime", dateTime: null, timeZone: null },
        status: null,
      },
    ]);
  });

  it("rejects semantic input before auth and sanitizes API failures", async () => {
    const provider = { getClient: vi.fn(async () => mockClient()) };
    const tool = register(provider, fixedTime);

    for (const params of [
      { maxResults: 0 },
      { maxResults: 21 },
      { maxResults: 1.5 },
      { timeMin: "2026-06-01T10:00Z" },
      { timeZone: "Invalid/Synthetic" },
    ]) {
      const result = await execute(tool, params);
      expect(result.isError).toBe(true);
    }
    expect(provider.getClient).not.toHaveBeenCalled();

    const failedTool = register(
      {
        getClient: vi.fn(async () => {
          throw new Error("access_token=secret-token client_secret=secret-client");
        }),
      },
      fixedTime,
    );
    const failed = await execute(failedTool, {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("/gws-login calendar");
    expect(JSON.stringify(failed)).not.toMatch(
      /secret-token|secret-client|access_token|client_secret/,
    );
  });
});
