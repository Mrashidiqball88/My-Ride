/**
 * Back-fill helper for drivers who paid under the old system.
 *
 * The old system only set `lastDailyFeePaidAt` (a timestamp) and never
 * wrote `paidUntilDate`.  When a driver with `paidUntilDate == null` and
 * a same-day `lastDailyFeePaidAt` logs in, we grant them access through
 * the end of that UTC calendar day — exactly as if they had paid under
 * the new system.
 *
 * Extracted as a pure, side-effect-free function so boundary conditions
 * (today, yesterday, already-set, customer role) can be unit-tested
 * without a live database.
 *
 * @param {{ role: string, paidUntilDate: Date|null, lastDailyFeePaidAt: Date|null }} user
 * @param {Date} [now]  Injection point for "current time" (defaults to Date.now()).
 * @returns {Date|null}  The Date to save as paidUntilDate, or null when no back-fill is needed.
 */
function computeBackfillPaidUntil(user, now = new Date()) {
  // Only applies to drivers
  if (user.role !== 'driver') return null;

  // Skip when paidUntilDate is already recorded
  if (user.paidUntilDate) return null;

  // Skip when there is nothing to back-fill from
  if (!user.lastDailyFeePaidAt) return null;

  const todayUTCMidnight = new Date(now);
  todayUTCMidnight.setUTCHours(0, 0, 0, 0);

  // Back-fill only if lastDailyFeePaidAt falls within today (UTC)
  if (user.lastDailyFeePaidAt < todayUTCMidnight) return null;

  // Grant access through 23:59:59.999 UTC today
  const endOfTodayUTC = new Date(todayUTCMidnight);
  endOfTodayUTC.setUTCHours(23, 59, 59, 999);
  return endOfTodayUTC;
}

module.exports = { computeBackfillPaidUntil };
