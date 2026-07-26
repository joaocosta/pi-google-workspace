import { DateTime, IANAZone } from "luxon";
import type { calendar_v3 } from "googleapis";

const LOCAL_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export interface CalendarTimeDependencies {
  readonly now?: () => Date;
  readonly hostTimeZone?: () => string | undefined;
}

export interface EventRangeInput {
  readonly timeMin?: string;
  readonly timeMax?: string;
  readonly timeZone?: string;
}

export interface ResolvedEventRange {
  readonly timeZone: string;
  readonly timeMin?: string;
  readonly timeMax?: string;
}

export class CalendarInputError extends Error {}

export function resolveHostTimeZone(): string | undefined {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function requireIanaTimeZone(timeZone: string | undefined): string {
  if (!timeZone || !IANAZone.isValidZone(timeZone)) {
    throw new CalendarInputError(
      "Calendar timeZone must be a valid IANA zone; the host zone could not be used.",
    );
  }
  return timeZone;
}

/** Convert an offset-free local date-time in an IANA zone to a Google RFC3339 instant. */
export function localDateTimeToRfc3339(value: string, timeZone: string): string {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) {
    throw new CalendarInputError(
      "Calendar bounds must be offset-free local date-times such as 2026-04-05T09:30:00.",
    );
  }

  const [, year, month, day, hour, minute, second = "0", fraction = ""] = match;
  const parts = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    millisecond: Number(fraction.padEnd(3, "0")),
  };
  const dateTime = DateTime.fromObject(parts, { zone: requireIanaTimeZone(timeZone) });

  // Luxon shifts nonexistent wall times across DST gaps, so compare every local component.
  if (
    !dateTime.isValid ||
    dateTime.year !== parts.year ||
    dateTime.month !== parts.month ||
    dateTime.day !== parts.day ||
    dateTime.hour !== parts.hour ||
    dateTime.minute !== parts.minute ||
    dateTime.second !== parts.second ||
    dateTime.millisecond !== parts.millisecond
  ) {
    throw new CalendarInputError(
      "Calendar bound is not a valid local date-time in the selected IANA zone.",
    );
  }

  const instant = dateTime.toISO({ includeOffset: true, extendedZone: false });
  if (!instant) {
    throw new CalendarInputError("Calendar bound could not be converted to RFC3339.");
  }
  return instant;
}

/** Resolve explicit bounds, or an exact seven-day default window, with injectable host time. */
export function resolveEventRange(
  input: EventRangeInput,
  dependencies: CalendarTimeDependencies = {},
): ResolvedEventRange {
  const timeZone = requireIanaTimeZone(
    input.timeZone ?? (dependencies.hostTimeZone ?? resolveHostTimeZone)(),
  );

  if (input.timeMin === undefined && input.timeMax === undefined) {
    const now = (dependencies.now ?? (() => new Date()))();
    if (Number.isNaN(now.getTime())) {
      throw new CalendarInputError("Calendar clock did not provide a valid instant.");
    }
    const timeMin = DateTime.fromJSDate(now, { zone: timeZone }).toISO();
    const timeMax = DateTime.fromMillis(now.getTime() + SEVEN_DAYS_MS, {
      zone: timeZone,
    }).toISO();
    if (!timeMin || !timeMax) {
      throw new CalendarInputError("Calendar default range could not be converted to RFC3339.");
    }
    return { timeZone, timeMin, timeMax };
  }

  const timeMin =
    input.timeMin === undefined
      ? undefined
      : localDateTimeToRfc3339(input.timeMin, timeZone);
  const timeMax =
    input.timeMax === undefined
      ? undefined
      : localDateTimeToRfc3339(input.timeMax, timeZone);

  if (timeMin !== undefined && timeMax !== undefined) {
    if (DateTime.fromISO(timeMin).toMillis() >= DateTime.fromISO(timeMax).toMillis()) {
      throw new CalendarInputError("Calendar timeMax must be later than timeMin.");
    }
  }

  return { timeZone, ...(timeMin ? { timeMin } : {}), ...(timeMax ? { timeMax } : {}) };
}

export function normalizeEventTime(value: calendar_v3.Schema$EventDateTime | undefined) {
  if (value?.date) {
    return {
      kind: "allDay" as const,
      date: value.date,
      timeZone: value.timeZone ?? null,
    };
  }
  return {
    kind: "dateTime" as const,
    dateTime: value?.dateTime ?? null,
    timeZone: value?.timeZone ?? null,
  };
}

export function normalizeCalendarEvent(calendarId: string, event: calendar_v3.Schema$Event) {
  return {
    calendarId,
    id: event.id ?? null,
    summary: event.summary ?? null,
    ...(event.description === undefined || event.description === null
      ? {}
      : { description: event.description }),
    ...(event.location === undefined || event.location === null
      ? {}
      : { location: event.location }),
    start: normalizeEventTime(event.start),
    end: normalizeEventTime(event.end),
    status: event.status ?? null,
    ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}),
    ...(event.originalStartTime
      ? { originalStartTime: normalizeEventTime(event.originalStartTime) }
      : {}),
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
  };
}
