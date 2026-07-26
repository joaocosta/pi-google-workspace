import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import type { CalendarClient, CalendarClientProvider } from "../src/calendar/client.js";
import {
  buildCalendarEvent,
  CalendarInputError,
  deriveCalendarEventId,
} from "../src/calendar/events.js";
import { registerCalendar } from "../src/calendar/index.js";

type ToolOptions = {
  parameters: object;
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

function mockClient(): CalendarClient {
  return {
    calendarList: {
      list: vi.fn(async () => ({ data: { items: [] } })),
      get: vi.fn(async ({ calendarId }) => ({
        data: {
          id: calendarId === "primary" ? "owner@example.test" : calendarId,
          summary: calendarId === "primary" ? "Synthetic Primary" : "Synthetic Team",
          accessRole: "owner",
        },
      })),
    },
    events: {
      list: vi.fn(async () => ({ data: { items: [] } })),
      insert: vi.fn(async ({ requestBody }) => ({
        data: { ...requestBody, htmlLink: "https://calendar.example.test/event" },
      })),
      get: vi.fn(async () => ({ data: {} })),
    },
  };
}

function register(
  clientProvider: CalendarClientProvider,
  hostTimeZone: () => string | undefined = () => "Europe/Lisbon",
) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerCalendar(pi as never, { auth: authService(), clientProvider, time: { hostTimeZone } });
  return tools.get("gws_calendar_create_event")!;
}

const timed = {
  kind: "timed",
  start: "2026-06-02T09:00:00",
  end: "2026-06-02T10:30:00",
} as const;

async function execute(
  tool: ToolOptions,
  params: object,
  options: { toolCallId?: string; confirm?: boolean; hasUI?: boolean } = {},
) {
  const confirm = vi.fn(async (_title: string, _message: string) => options.confirm ?? true);
  const result = await tool.execute(
    options.toolCallId ?? "synthetic-tool-call",
    params,
    undefined,
    undefined,
    { hasUI: options.hasUI ?? false, ui: { confirm } },
  );
  return { result, confirm };
}

describe("Calendar event creation builders", () => {
  it("derives deterministic IDs within Google base32hex-compatible constraints", () => {
    const first = deriveCalendarEventId("same-call");
    expect(first).toBe(deriveCalendarEventId("same-call"));
    expect(first).not.toBe(deriveCalendarEventId("different-call"));
    expect(first).toMatch(/^[0-9a-v]{5,1024}$/);
    expect(first).toHaveLength(64);
  });

  it("builds exact timed and all-day request bodies", () => {
    expect(
      buildCalendarEvent(
        "timed-call",
        {
          summary: "  Synthetic planning  ",
          description: "Agenda",
          location: "Room 1",
          timing: { ...timed, timeZone: "Europe/Lisbon" },
        },
        { hostTimeZone: () => "UTC" },
      ).requestBody,
    ).toEqual({
      id: deriveCalendarEventId("timed-call"),
      summary: "Synthetic planning",
      description: "Agenda",
      location: "Room 1",
      start: { dateTime: "2026-06-02T09:00:00.000+01:00", timeZone: "Europe/Lisbon" },
      end: { dateTime: "2026-06-02T10:30:00.000+01:00", timeZone: "Europe/Lisbon" },
      reminders: { useDefault: true },
    });

    expect(
      buildCalendarEvent("all-day-call", {
        summary: "Holiday",
        timing: { kind: "allDay", startDate: "2026-06-04", endDate: "2026-06-06" },
      }).requestBody,
    ).toEqual({
      id: deriveCalendarEventId("all-day-call"),
      summary: "Holiday",
      start: { date: "2026-06-04" },
      end: { date: "2026-06-06" },
      reminders: { useDefault: true },
    });
  });

  it("rejects every bounded timing validation branch", () => {
    const invalid = [
      { summary: " ", timing: timed },
      { summary: "Event", timing: { ...timed, start: "2026-06-02T09:00:00Z" } },
      { summary: "Event", timing: { ...timed, end: "2026-06-02T10:00:00+01:00" } },
      { summary: "Event", timing: { ...timed, timeZone: "Invalid/Synthetic" } },
      { summary: "Event", timing: { ...timed, end: timed.start } },
      {
        summary: "Event",
        timing: { kind: "timed", start: "2026-03-29T01:30:00", end: "2026-03-29T03:30:00", timeZone: "Europe/Lisbon" },
      },
      { summary: "Event", timing: { kind: "allDay", startDate: "2026-2-01", endDate: "2026-02-03" } },
      { summary: "Event", timing: { kind: "allDay", startDate: "2026-02-30", endDate: "2026-03-03" } },
      { summary: "Event", timing: { kind: "allDay", startDate: "2026-03-03", endDate: "2026-03-03" } },
    ];
    for (const input of invalid) {
      expect(() => buildCalendarEvent("call", input as never)).toThrow(CalendarInputError);
    }
    expect(() =>
      buildCalendarEvent("call", { summary: "Event", timing: timed }, { hostTimeZone: () => undefined }),
    ).toThrow(/valid IANA zone/);
  });
});

describe("gws_calendar_create_event", () => {
  it("registers only the bounded core schema and exact Calendar surface", () => {
    const client = mockClient();
    const tools = new Map<string, ToolOptions>();
    const pi = { registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)) };
    registerCalendar(pi as never, { auth: authService(), clientProvider: { getClient: async () => client } });

    expect([...tools.keys()]).toEqual([
      "gws_calendar_list",
      "gws_calendar_list_events",
      "gws_calendar_create_event",
    ]);
    const schema = JSON.stringify(tools.get("gws_calendar_create_event")!.parameters);
    expect(schema).toContain('"timing"');
    expect(schema).not.toMatch(/attendee|recurrence|conference|visibility|color|send|update|delete/i);
  });

  it("validates before auth, confirmation, or mutation", async () => {
    const provider = { getClient: vi.fn(async () => mockClient()) };
    const tool = register(provider);
    const { result, confirm } = await execute(tool, { summary: " ", timing: timed }, { hasUI: true });

    expect(result.isError).toBe(true);
    expect(provider.getClient).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms a resolved non-primary target and sends the exact timed body", async () => {
    const client = mockClient();
    const tool = register({ getClient: async () => client });
    const { result, confirm } = await execute(
      tool,
      {
        calendarId: "team@example.test",
        summary: "Planning",
        description: "Agenda",
        location: "Room 1",
        timing: timed,
      },
      { hasUI: true, toolCallId: "timed-insert" },
    );

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toContain("Calendar: Synthetic Team (team@example.test)");
    expect(confirm.mock.calls[0][1]).toContain("Time zone: Europe/Lisbon");
    expect(client.events.insert).toHaveBeenCalledWith(
      {
        calendarId: "team@example.test",
        requestBody: {
          id: deriveCalendarEventId("timed-insert"),
          summary: "Planning",
          description: "Agenda",
          location: "Room 1",
          start: { dateTime: "2026-06-02T09:00:00.000+01:00", timeZone: "Europe/Lisbon" },
          end: { dateTime: "2026-06-02T10:30:00.000+01:00", timeZone: "Europe/Lisbon" },
          reminders: { useDefault: true },
        },
      },
      { signal: undefined },
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      calendarId: "team@example.test",
      id: deriveCalendarEventId("timed-insert"),
      summary: "Planning",
      htmlLink: "https://calendar.example.test/event",
    });
  });

  it("uses primary, confirms the exclusive all-day range, and supports headless intent", async () => {
    const client = mockClient();
    const tool = register({ getClient: async () => client });
    const params = {
      summary: "Synthetic holiday",
      timing: { kind: "allDay", startDate: "2026-06-04", endDate: "2026-06-05" },
    };

    const interactive = await execute(tool, params, { hasUI: true });
    expect(interactive.confirm.mock.calls[0][1]).toContain("Synthetic Primary (owner@example.test)");
    expect(interactive.confirm.mock.calls[0][1]).toContain("Exclusive end: 2026-06-05");

    await execute(tool, params, { hasUI: false, toolCallId: "headless-call" });
    expect(client.events.insert).toHaveBeenCalledTimes(2);
  });

  it("returns cancellation as a non-error and performs no insert", async () => {
    const client = mockClient();
    const tool = register({ getClient: async () => client });
    const { result } = await execute(
      tool,
      { summary: "Cancelled", timing: timed },
      { hasUI: true, confirm: false },
    );

    expect(result.isError).toBeUndefined();
    expect(result.details.cancelled).toBe(true);
    expect(client.events.insert).not.toHaveBeenCalled();
  });

  it("falls back to the selected ID when metadata is unavailable", async () => {
    const client = mockClient();
    vi.mocked(client.calendarList.get).mockRejectedValueOnce(new Error("metadata unavailable"));
    const tool = register({ getClient: async () => client });
    const { confirm } = await execute(
      tool,
      { calendarId: "fallback@example.test", summary: "Fallback", timing: timed },
      { hasUI: true },
    );

    expect(confirm.mock.calls[0][1]).toContain("fallback@example.test (fallback@example.test)");
    expect(client.events.insert).toHaveBeenCalledTimes(1);
  });

  it("rejects known read-only calendars without confirmation or insertion", async () => {
    const client = mockClient();
    vi.mocked(client.calendarList.get).mockResolvedValueOnce({
      data: { id: "readonly@example.test", summary: "Read only", accessRole: "reader" },
    });
    const tool = register({ getClient: async () => client });
    const { result, confirm } = await execute(
      tool,
      { calendarId: "readonly@example.test", summary: "No write", timing: timed },
      { hasUI: true },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Choose a writable calendar");
    expect(confirm).not.toHaveBeenCalled();
    expect(client.events.insert).not.toHaveBeenCalled();
  });

  it("recovers the same deterministic ID after a conflict", async () => {
    const client = mockClient();
    const eventId = deriveCalendarEventId("retry-call");
    vi.mocked(client.events.insert).mockRejectedValueOnce({ response: { status: 409 } });
    vi.mocked(client.events.get).mockResolvedValueOnce({
      data: {
        id: eventId,
        summary: "Existing",
        start: { date: "2026-06-04" },
        end: { date: "2026-06-05" },
      },
    });
    const tool = register({ getClient: async () => client });
    const { result } = await execute(
      tool,
      {
        summary: "Existing",
        timing: { kind: "allDay", startDate: "2026-06-04", endDate: "2026-06-05" },
      },
      { toolCallId: "retry-call" },
    );

    expect(client.events.get).toHaveBeenCalledWith(
      { calendarId: "primary", eventId },
      { signal: undefined },
    );
    expect(result.details).toMatchObject({ eventId, idempotent: true });
    expect(JSON.parse(result.content[0].text).idempotent).toBe(true);
    expect(client.events.insert).toHaveBeenCalledTimes(1);
  });

  it("fails safely for unexpected conflicts, recovery mismatches, and permission errors", async () => {
    for (const setup of [
      (client: CalendarClient) => vi.mocked(client.events.insert).mockRejectedValueOnce({ code: 403, message: "access_token=secret" }),
      (client: CalendarClient) => {
        vi.mocked(client.events.insert).mockRejectedValueOnce({ code: 409 });
        vi.mocked(client.events.get).mockResolvedValueOnce({ data: { id: "different-id" } });
      },
    ]) {
      const client = mockClient();
      setup(client);
      const tool = register({ getClient: async () => client });
      const { result } = await execute(
        tool,
        { calendarId: "selected@example.test", summary: "Failure", timing: timed },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("selected@example.test");
      expect(result.content[0].text).toContain("writable calendar");
      expect(JSON.stringify(result)).not.toMatch(/access_token|secret/);
      expect(client.events.insert).toHaveBeenCalledTimes(1);
    }
  });
});
