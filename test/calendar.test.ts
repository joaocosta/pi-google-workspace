import { describe, expect, it, vi } from "vitest";
import { createWorkspaceAppRegistry } from "../src/auth/apps.js";
import type { OAuthClient, WorkspaceAuthService } from "../src/auth/oauth.js";
import { createTokenStore } from "../src/auth/token-store.js";
import {
  createCalendarClientProvider,
  type CalendarClient,
  type CalendarClientProvider,
} from "../src/calendar/client.js";
import { registerCalendar } from "../src/calendar/index.js";

type ToolOptions = {
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: Function;
};

function authService(overrides: Partial<WorkspaceAuthService> = {}): WorkspaceAuthService {
  return {
    apps: createWorkspaceAppRegistry(createTokenStore({ homeRoot: "/synthetic-home" })),
    login: vi.fn(),
    getAuthenticatedClient: vi.fn(),
    getStatus: vi.fn(),
    logout: vi.fn(),
    ...overrides,
  };
}

function register(clientProvider: CalendarClientProvider) {
  const tools = new Map<string, ToolOptions>();
  const pi = {
    registerTool: vi.fn((tool: ToolOptions & { name: string }) => tools.set(tool.name, tool)),
  };
  registerCalendar(pi as never, { auth: authService(), clientProvider });
  return { tools, pi };
}

function mockClient(data: object = { items: [] }): CalendarClient {
  return {
    calendarList: {
      list: vi.fn(async () => ({ data })),
    },
    events: {
      list: vi.fn(async () => ({ data: { items: [] } })),
    },
  };
}

async function execute(tool: ToolOptions, params: object, signal?: AbortSignal) {
  return tool.execute("synthetic-call", params, signal, undefined, { hasUI: false });
}

describe("Calendar discovery", () => {
  it("registers only the prefixed discovery tool with explicit prompt guidance", () => {
    const { tools } = register({ getClient: vi.fn(async () => mockClient()) });

    expect([...tools.keys()]).toEqual([
      "gws_calendar_list",
      "gws_calendar_list_events",
    ]);
    const tool = tools.get("gws_calendar_list")!;
    expect(`${tool.description} ${tool.promptSnippet} ${tool.promptGuidelines?.join(" ")}`).toContain(
      "gws_calendar_list",
    );
  });

  it("uses the default, custom, and maximum limits in one request per call", async () => {
    const client = mockClient({ items: [], nextPageToken: "next-page" });
    const { tools } = register({ getClient: vi.fn(async () => client) });
    const tool = tools.get("gws_calendar_list")!;

    await execute(tool, {});
    await execute(tool, { maxResults: 4 });
    await execute(tool, { maxResults: 10 });

    expect(client.calendarList.list).toHaveBeenCalledTimes(3);
    expect(client.calendarList.list).toHaveBeenNthCalledWith(
      1,
      { maxResults: 10 },
      { signal: undefined },
    );
    expect(client.calendarList.list).toHaveBeenNthCalledWith(
      2,
      { maxResults: 4 },
      { signal: undefined },
    );
    expect(client.calendarList.list).toHaveBeenNthCalledWith(
      3,
      { maxResults: 10 },
      { signal: undefined },
    );
  });

  it("forwards page tokens, maps fields safely, and returns the next token without auto-paging", async () => {
    const client = mockClient({
      items: [
        {
          id: "team@example.test",
          summary: "Synthetic Team",
          primary: true,
          timeZone: "Europe/Lisbon",
          accessRole: "owner",
        },
        {},
      ],
      nextPageToken: "next-synthetic-page",
    });
    const { tools } = register({ getClient: vi.fn(async () => client) });
    const signal = new AbortController().signal;

    const result = await execute(
      tools.get("gws_calendar_list")!,
      { maxResults: 2, pageToken: "current-synthetic-page" },
      signal,
    );

    expect(client.calendarList.list).toHaveBeenCalledTimes(1);
    expect(client.calendarList.list).toHaveBeenCalledWith(
      { maxResults: 2, pageToken: "current-synthetic-page" },
      { signal },
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      calendars: [
        {
          id: "team@example.test",
          summary: "Synthetic Team",
          primary: true,
          timeZone: "Europe/Lisbon",
          accessRole: "owner",
        },
        {
          id: null,
          summary: null,
          primary: false,
          timeZone: null,
          accessRole: null,
        },
      ],
      nextPageToken: "next-synthetic-page",
    });
    expect(result.details).toEqual({
      app: "calendar",
      count: 2,
      nextPageToken: "next-synthetic-page",
    });
  });

  it("returns an explicit empty page and rejects invalid limits before authentication", async () => {
    const provider = { getClient: vi.fn(async () => mockClient({})) };
    const { tools } = register(provider);
    const tool = tools.get("gws_calendar_list")!;

    const empty = await execute(tool, {});
    expect(JSON.parse(empty.content[0].text)).toEqual({ calendars: [] });

    for (const maxResults of [0, 11, 1.5]) {
      const result = await execute(tool, { maxResults });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("integer from 1 to 10");
    }
    expect(provider.getClient).toHaveBeenCalledTimes(1);
  });

  it("acquires only Calendar auth and sanitizes client failures", async () => {
    const oauthClient = {} as OAuthClient;
    const getAuthenticatedClient = vi.fn(async () => oauthClient);
    const factory = vi.fn(() => mockClient());
    const provider = createCalendarClientProvider(authService({ getAuthenticatedClient }), factory);

    await provider.getClient();
    expect(getAuthenticatedClient).toHaveBeenCalledWith("calendar");
    expect(getAuthenticatedClient).not.toHaveBeenCalledWith("gmail");
    expect(factory).toHaveBeenCalledWith(oauthClient);

    const { tools } = register({
      getClient: vi.fn(async () => {
        throw new Error("access_token=secret-token client_secret=secret-client");
      }),
    });
    const result = await execute(tools.get("gws_calendar_list")!, {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("/gws-login calendar");
    expect(JSON.stringify(result)).not.toMatch(/secret-token|secret-client|access_token|client_secret/);
  });
});
