import { google, type calendar_v3 } from "googleapis";
import type { OAuthClient, WorkspaceAuthService } from "../auth/oauth.js";

export interface CalendarRequestOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface CalendarClient {
  readonly calendarList: {
    list(
      request: calendar_v3.Params$Resource$Calendarlist$List,
      options?: CalendarRequestOptions,
    ): Promise<{ data: calendar_v3.Schema$CalendarList }>;
    get(
      request: calendar_v3.Params$Resource$Calendarlist$Get,
      options?: CalendarRequestOptions,
    ): Promise<{ data: calendar_v3.Schema$CalendarListEntry }>;
  };
  readonly events: {
    list(
      request: calendar_v3.Params$Resource$Events$List,
      options?: CalendarRequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Events }>;
    insert(
      request: calendar_v3.Params$Resource$Events$Insert,
      options?: CalendarRequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Event }>;
    get(
      request: calendar_v3.Params$Resource$Events$Get,
      options?: CalendarRequestOptions,
    ): Promise<{ data: calendar_v3.Schema$Event }>;
  };
}

export type CalendarClientFactory = (authClient: OAuthClient) => CalendarClient;

export function createGoogleCalendarClient(authClient: OAuthClient): CalendarClient {
  if (!authClient.googleAuthClient) {
    throw new Error("Google API authentication transport is unavailable.");
  }
  const calendar = google.calendar({ version: "v3", auth: authClient.googleAuthClient });
  return {
    calendarList: {
      list(request, options) {
        return options?.signal === undefined
          ? calendar.calendarList.list(request)
          : calendar.calendarList.list(request, { signal: options.signal });
      },
      get(request, options) {
        return options?.signal === undefined
          ? calendar.calendarList.get(request)
          : calendar.calendarList.get(request, { signal: options.signal });
      },
    },
    events: {
      list(request, options) {
        return options?.signal === undefined
          ? calendar.events.list(request)
          : calendar.events.list(request, { signal: options.signal });
      },
      insert(request, options) {
        return options?.signal === undefined
          ? calendar.events.insert(request)
          : calendar.events.insert(request, { signal: options.signal });
      },
      get(request, options) {
        return options?.signal === undefined
          ? calendar.events.get(request)
          : calendar.events.get(request, { signal: options.signal });
      },
    },
  };
}

export interface CalendarClientProvider {
  getClient(): Promise<CalendarClient>;
}

/** Acquire only Calendar authorization and construct the service through an injectable seam. */
export function createCalendarClientProvider(
  auth: WorkspaceAuthService,
  factory: CalendarClientFactory = createGoogleCalendarClient,
): CalendarClientProvider {
  return {
    async getClient() {
      return factory(await auth.getAuthenticatedClient("calendar"));
    },
  };
}
