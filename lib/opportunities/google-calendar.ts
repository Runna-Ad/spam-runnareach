/**
 * Google Calendar read for the booking sync (lib/opportunities/calendar-sync.ts).
 *
 * Appointment-schedule bookings are ordinary events on the connected account's
 * primary calendar, with the booker as an attendee. There is no booking webhook,
 * so the sync polls: events updated in the last 48 hours, cancelled ones included.
 *
 * A 403 for missing scope is expected until the inbox is reconnected with
 * calendar.readonly: it comes back as `needsReconnect`, never as a throw.
 *
 * No server imports, so tests can load it with a fake fetch.
 */

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const TIMEOUT_MS = 10_000;
export const LOOKBACK_MS = 48 * 60 * 60 * 1000;

export type CalendarAttendee = {
  email?: string;
  self?: boolean;
  organizer?: boolean;
  optional?: boolean;
  responseStatus?: string;
};

export type CalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  organizer?: { email?: string; self?: boolean };
  start?: { dateTime?: string; date?: string };
  attendees?: CalendarAttendee[];
};

export type ListEventsResult =
  /** truncated: Google returned a nextPageToken; only the first page was read. */
  | { ok: true; events: CalendarEvent[]; truncated: boolean }
  | { ok: false; needsReconnect: true; error: string }
  | { ok: false; needsReconnect: false; error: string };

/** A 403 that means the token lacks the Calendar scope (not a quota or ACL 403). */
export function isScopeError(status: number, body: string): boolean {
  return status === 403 && /insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(body);
}

export async function listRecentEvents(
  accessToken: string,
  opts: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<ListEventsResult> {
  const now = opts.now ?? new Date();
  const doFetch = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    updatedMin: new Date(now.getTime() - LOOKBACK_MS).toISOString(),
    singleEvents: "true",
    showDeleted: "true",
    maxResults: "100",
  });

  let res: Response;
  try {
    res = await doFetch(`${EVENTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, needsReconnect: false, error: `Calendar request failed: ${(err as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (isScopeError(res.status, body)) {
      return { ok: false, needsReconnect: true, error: "Calendar scope not granted; reconnect Google for this inbox." };
    }
    return { ok: false, needsReconnect: false, error: `Calendar list failed (${res.status}): ${body.slice(0, 200)}` };
  }

  const json = (await res.json().catch(() => null)) as { items?: unknown; nextPageToken?: unknown } | null;
  const items = Array.isArray(json?.items) ? (json.items as unknown[]) : [];
  const events = items.filter(
    (e): e is CalendarEvent => typeof e === "object" && e !== null && typeof (e as { id?: unknown }).id === "string",
  );
  return { ok: true, events, truncated: typeof json?.nextPageToken === "string" && json.nextPageToken !== "" };
}
