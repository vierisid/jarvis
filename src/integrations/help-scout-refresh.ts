import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readHelpScoutConnection } from "./help-scout-connection";
const refresh = createManagedRotatingRefresher(
  "help-scout",
  "Help Scout",
  readHelpScoutConnection,
);
export const freshHelpScoutConnection = refresh.fresh;
export const helpScoutNeedsReconnect = refresh.needsReconnect;
export const helpScoutGrantKey = refresh.grantKey;
