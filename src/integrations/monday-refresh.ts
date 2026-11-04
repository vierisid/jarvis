import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readMondayConnection } from "./monday-connection";
const refresh = createManagedRotatingRefresher(
  "monday",
  "monday.com",
  readMondayConnection,
);
export const freshMondayConnection = refresh.fresh;
export const mondayNeedsReconnect = refresh.needsReconnect;
export const mondayGrantKey = refresh.grantKey;
