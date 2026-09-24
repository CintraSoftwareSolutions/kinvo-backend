/**
 * Calendar months, clamped the way the stores count a billing period: 31
 * January plus one month is the last day of February, not 3 March, and a
 * yearly plan bought on 29 February ends on 28 February. Time of day is kept.
 *
 * UTC throughout, like every timestamp in this API (spec §4.6).
 */
export function addMonths(from: Date, months: number): Date {
  const result = new Date(from);
  const day = result.getUTCDate();

  // Day 1 first, so the month can move without overflowing into the next one.
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));

  return result;
}
