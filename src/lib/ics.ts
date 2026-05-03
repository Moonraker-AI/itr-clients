/**
 * Minimal RFC-5545 VCALENDAR builder for retreat-date confirmations
 * (DESIGN.md §8 — calendar integration, M4).
 *
 * One VEVENT, all-day, spanning startDate → endDate (inclusive).
 * In iCalendar, all-day DTEND is *exclusive*, so we add one day to
 * the supplied endDate.
 *
 * SUMMARY/DESCRIPTION are PHI-free per DESIGN §8 + §16. Caller MUST
 * NOT pass clinical context, client name, or location detail beyond
 * a venue label.
 */

export interface BuildIcsArgs {
  /** Stable UID for the event (use `retreatId` so re-confirmations replace). */
  uid: string;
  /** ISO date `YYYY-MM-DD` (inclusive). */
  startDate: string;
  /** ISO date `YYYY-MM-DD` (inclusive — converted to exclusive DTEND). */
  endDate: string;
  /** PHI-free. e.g. "ITR retreat". */
  summary: string;
  /** PHI-free. Optional. */
  description?: string;
  /** PHI-free. Optional. e.g. "Northampton, MA". */
  location?: string;
  /** ISO timestamp; defaults to now. Used for DTSTAMP + LAST-MODIFIED. */
  now?: Date;
  /** Bumped on re-confirmation; defaults to 0. */
  sequence?: number;
}

const PRODID = '-//Intensive Therapy Retreats//Client HQ//EN';
const MAX_LINE_OCTETS = 75;

/**
 * Returns the iCalendar body. Lines are CRLF-terminated and folded at
 * 75 octets per RFC-5545 §3.1.
 */
export function buildIcs(args: BuildIcsArgs): string {
  assertIsoDate(args.startDate, 'startDate');
  assertIsoDate(args.endDate, 'endDate');
  if (args.endDate < args.startDate) {
    throw new Error('ics: endDate must be >= startDate');
  }

  const stamp = formatStamp(args.now ?? new Date());
  const dtstart = args.startDate.replaceAll('-', '');
  const dtend = addOneDay(args.endDate).replaceAll('-', '');

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${args.uid}`,
    `DTSTAMP:${stamp}`,
    `SEQUENCE:${args.sequence ?? 0}`,
    `DTSTART;VALUE=DATE:${dtstart}`,
    `DTEND;VALUE=DATE:${dtend}`,
    `SUMMARY:${escapeText(args.summary)}`,
  ];
  if (args.description) lines.push(`DESCRIPTION:${escapeText(args.description)}`);
  if (args.location) lines.push(`LOCATION:${escapeText(args.location)}`);
  lines.push('TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}

function assertIsoDate(s: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`ics: ${field} must be YYYY-MM-DD`);
  }
}

function addOneDay(iso: string): string {
  // Use UTC arithmetic to keep all-day dates calendar-stable regardless
  // of the host TZ.
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatStamp(d: Date): string {
  const iso = d.toISOString();
  // 2026-05-03T17:34:21.000Z → 20260503T173421Z
  return iso.replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '');
}

function escapeText(s: string): string {
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}

/**
 * RFC-5545 §3.1 line folding: 75 octets max, continuation lines start
 * with a single space. Operate on UTF-8 bytes, not chars, since SUMMARY
 * may contain multibyte glyphs.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= MAX_LINE_OCTETS) return line;
  const parts: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < bytes.length) {
    const limit = first ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1;
    const end = Math.min(offset + limit, bytes.length);
    const chunk = bytes.subarray(offset, end).toString('utf8');
    parts.push(first ? chunk : ` ${chunk}`);
    offset = end;
    first = false;
  }
  return parts.join('\r\n');
}
