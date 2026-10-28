import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readTypeformConnection } from "./typeform-connection";
const refresh = createManagedRotatingRefresher(
  "typeform",
  "Typeform",
  readTypeformConnection,
);
export const freshTypeformConnection = refresh.fresh;
export const typeformNeedsReconnect = refresh.needsReconnect;
export const typeformGrantKey = refresh.grantKey;
