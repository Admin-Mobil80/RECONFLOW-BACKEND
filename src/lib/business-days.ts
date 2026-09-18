/**
 * Whole business days (Mon–Fri) strictly after `from` up to and including
 * `to`, ignoring holidays. Enough for "how long has this been waiting";
 * a tenant calendar can replace it later without touching the callers.
 */
export function businessDaysBetween(from: Date | string, to: Date | string): number {
  const start = startOfUtcDay(new Date(from));
  const end = startOfUtcDay(new Date(to));
  if (end <= start) return 0;

  let count = 0;
  const cursor = new Date(start);
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
