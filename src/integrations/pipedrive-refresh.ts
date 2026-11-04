import { createManagedTokenRefresher } from "./managed-refresh";
import { readPipedriveConnection } from "./pipedrive-connection";
const refresh = createManagedTokenRefresher(
  "pipedrive",
  "Pipedrive",
  readPipedriveConnection,
);
export const freshPipedriveConnection = refresh.fresh;
export const pipedriveNeedsReconnect = refresh.needsReconnect;
export const pipedriveGrantKey = refresh.grantKey;
