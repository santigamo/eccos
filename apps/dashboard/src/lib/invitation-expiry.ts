/** How long an invitation works. Feeds Better Auth's `invitationExpiresIn` and the copy that quotes it. */
export const INVITATION_LIFETIME_DAYS = 7;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** When an invitation stops working, in words; the exact time goes on the line under it. */
export function expiresIn(at: number, now: number): string {
  const left = at - now;
  if (left <= 0) return "Expired";
  if (left >= DAY) {
    const days = Math.round(left / DAY);
    return `in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (left >= HOUR) return `in ${Math.round(left / HOUR)} h`;
  return `in ${Math.max(1, Math.round(left / MINUTE))} min`;
}
