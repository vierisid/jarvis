/**
 * The IANA zone this browser is in, or undefined when it cannot say (#1022).
 * Voice requests carry it so the daemon reads a time they name ("tomorrow at
 * 9am") in the zone the person reads the result in, and shows that instant on
 * the card before anything runs. They send "" when it cannot say: a request
 * with no zone at all is one from a tab that predates this.
 */
export function dashboardTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
