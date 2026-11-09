/**
 * Repeating bills: rent on the 1st, power every month, a cleaner every week.
 *
 * Monthly bills keep their day of the month. A bill on the 31st falls on the last
 * day of shorter months and comes back to the 31st afterwards:
 *   Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31
 * The database computes the same dates with next_due_date() in
 * supabase/migrations; supabase/tests checks the two agree.
 */

export type Every = 'week' | 'month';

/** A calendar date as YYYY-MM-DD, with no time zone. */
export type DateString = string;

function parts(date: DateString): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`expected a YYYY-MM-DD date, got ${date}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Day of the month a monthly bill belongs on (1 to 31). */
export function anchorDayOf(date: DateString): number {
  return parts(date)[2];
}

/**
 * The due date after `date`. For monthly bills, `anchorDay` is the day the bill
 * belongs on; leave it out and the day of `date` is used.
 */
export function nextDue(date: DateString, every: Every, anchorDay?: number): DateString {
  const [y, m, d] = parts(date);
  if (every === 'week') {
    return new Date(Date.UTC(y, m - 1, d + 7)).toISOString().slice(0, 10);
  }
  const day = anchorDay ?? d;
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(`anchor day must be 1 to 31, got ${day}`);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${pad(nm)}-${pad(Math.min(day, last))}`;
}

/** Every due date from `first` up to and including `until`, at most `limit` of them. */
export function dueDates(first: DateString, until: DateString, every: Every, anchorDay?: number, limit = 24): DateString[] {
  const out: DateString[] = [];
  const day = anchorDay ?? anchorDayOf(first);
  for (let d = first; d <= until && out.length < limit; d = nextDue(d, every, day)) out.push(d);
  return out;
}
