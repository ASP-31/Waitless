/** Dependency-free iCalendar generation for appointment downloads. */

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end?: string | null;
  description?: string | null;
  location?: string | null;
}

const SLOT_MINUTES = 15;

/** RFC 5545 text escaping (backslashes, newlines, semicolons and commas). */
function escapeText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

/** UTC iCalendar timestamp, or null when the input is not a valid date. */
function toIcsDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (part: number) => String(part).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

/**
 * Builds a VCALENDAR with CRLF line endings. Invalid event dates are skipped so
 * one bad record cannot corrupt the whole download.
 */
export function buildIcsCalendar(events: CalendarEvent[], now: Date = new Date()): string {
  const stamp = toIcsDate(now.toISOString()) ?? "19700101T000000Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Waitless//Appointments//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const event of events) {
    const start = toIcsDate(event.start);
    if (!start) continue;
    const fallbackEnd = new Date(new Date(event.start).getTime() + SLOT_MINUTES * 60_000).toISOString();
    const end = toIcsDate(event.end) ?? toIcsDate(fallbackEnd) ?? start;

    lines.push(
      "BEGIN:VEVENT",
      `UID:${escapeText(event.id)}@waitless.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeText(event.title || "Waitless appointment")}`,
    );
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

/** Browser download helper for the generated text. */
export function downloadIcsFile(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
