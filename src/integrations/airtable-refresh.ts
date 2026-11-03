import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readAirtableConnection } from "./airtable-connection";
const refresh = createManagedRotatingRefresher(
  "airtable",
  "Airtable",
  readAirtableConnection,
);
export const freshAirtableConnection = refresh.fresh;
export const airtableNeedsReconnect = refresh.needsReconnect;
export const airtableGrantKey = refresh.grantKey;
