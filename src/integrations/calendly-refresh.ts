import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readCalendlyConnection } from "./calendly-connection";
const refresh = createManagedRotatingRefresher(
  "calendly",
  "Calendly",
  readCalendlyConnection,
);
export const freshCalendlyConnection = refresh.fresh;
export const calendlyNeedsReconnect = refresh.needsReconnect;
export const calendlyGrantKey = refresh.grantKey;
