import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readZoomConnection } from "./zoom-connection";
const refresh = createManagedRotatingRefresher(
  "zoom",
  "Zoom",
  readZoomConnection,
);
export const freshZoomConnection = refresh.fresh;
export const zoomNeedsReconnect = refresh.needsReconnect;
export const zoomGrantKey = refresh.grantKey;
