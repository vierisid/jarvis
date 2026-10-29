import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readLinearConnection } from "./linear-connection";
const refresh = createManagedRotatingRefresher(
  "linear",
  "Linear",
  readLinearConnection,
);
export const freshLinearConnection = refresh.fresh;
export const linearNeedsReconnect = refresh.needsReconnect;
export const linearGrantKey = refresh.grantKey;
