import { config } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Returns { year, month, day, weekday } for an instant, as seen in the app's
// configured timezone. Weekday is 0 = Sunday.
function partsInTimezone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value])
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekdays[parts.weekday],
  };
}

const iso = (y, m, d) =>
  `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Today's ISO date (YYYY-MM-DD) as seen in the app's timezone. */
export function currentDate(now = new Date(), timeZone = config.timezone) {
  const { year, month, day } = partsInTimezone(now, timeZone);
  return iso(year, month, day);
}

/** ISO date (YYYY-MM-DD) of the Sunday that starts the current week. */
export function currentWeekStart(now = new Date(), timeZone = config.timezone) {
  const { year, month, day, weekday } = partsInTimezone(now, timeZone);
  // Anchor at noon UTC so DST shifts can never roll the date over.
  const anchor = Date.UTC(year, month - 1, day, 12);
  const sunday = new Date(anchor - weekday * DAY_MS);
  return iso(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate());
}

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a week key and confirms it is a Sunday. Returns null when invalid. */
export function normalizeWeek(value) {
  if (typeof value !== 'string' || !WEEK_RE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() + 1 !== m ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  if (date.getUTCDay() !== 0) return null;
  return value;
}

/** Shifts a week key by a number of whole weeks. */
export function addWeeks(week, delta) {
  const [y, m, d] = week.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12) + delta * 7 * DAY_MS);
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** The seven ISO dates of a week, Sunday first. */
export function weekDates(week) {
  return Array.from({ length: 7 }, (_, i) => shiftDays(week, i));
}

export function shiftDays(week, days) {
  const [y, m, d] = week.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12) + days * DAY_MS);
  return iso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}
