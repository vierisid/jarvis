import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readWrikeConnection } from "./wrike-connection";
const refresh = createManagedRotatingRefresher(
  "wrike",
  "Wrike",
  readWrikeConnection,
);
export const freshWrikeConnection = refresh.fresh;
export const wrikeNeedsReconnect = refresh.needsReconnect;
export const wrikeGrantKey = refresh.grantKey;
