/**
 * Booking alert: one email per calendar booking or cancellation the sync
 * applied, to the lead list (lib/notify, kind "lead").
 *
 * The start time is shown in the event's own time zone when it carries one,
 * else in UTC, and the zone is always named. Pure: tested in
 * tests/opportunities-calendar-sync.test.ts.
 */

export type BookingAlertInput = {
  kind: "booked" | "cancelled";
  company: string | null;
  attendee: string | null;
  /** Google start: dateTime (RFC 3339) or an all-day date. */
  start: string | null;
  /** The event's IANA time zone, when it carries one. */
  timeZone: string | null;
  market: string | null;
};

function validZone(tz: string | null): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** "Tue, Oct 20, 2026, 3:00 PM (America/Mexico_City)"; all-day → the date. */
export function formatStart(start: string | null, timeZone: string | null): string | null {
  if (!start) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) return `${start} (all day)`;
  const ms = Date.parse(start);
  if (Number.isNaN(ms)) return start;
  const zone = validZone(timeZone) ?? "UTC";
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
  return `${text} (${zone})`;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || "https://spam-runnareach.vercel.app";
}

export function formatBookingAlert(b: BookingAlertInput): { subject: string; body: string } {
  const company = b.company ?? b.attendee ?? "unknown prospect";
  const when = formatStart(b.start, b.timeZone) ?? "unknown time";
  const lines = [
    `When: ${when}`,
    `Who: ${b.attendee ?? "unknown attendee"}`,
    `Market: ${b.market ?? "unknown"}`,
  ].join("\n");
  const link = `${appUrl()}/opportunities`;

  if (b.kind === "booked") {
    return {
      subject: `Meeting booked: ${company} (${when})`,
      body: `${company} booked a meeting.\n\n${lines}\n\nOpen opportunities: ${link}`,
    };
  }
  return {
    subject: `Booking cancelled: ${company}`,
    body:
      `${company} cancelled their meeting. The opportunity is now marked lost (booking cancelled).\n\n` +
      `${lines}\n\nOpen opportunities: ${link}`,
  };
}
