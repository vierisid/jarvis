import { createManagedTokenRefresher } from "./managed-refresh";
import { readFigmaConnection } from "./figma-connection";
const refresh = createManagedTokenRefresher(
  "figma",
  "Figma",
  readFigmaConnection,
);
export const freshFigmaConnection = refresh.fresh;
export const figmaNeedsReconnect = refresh.needsReconnect;
export const figmaGrantKey = refresh.grantKey;
