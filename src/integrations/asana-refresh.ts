import {createManagedTokenRefresher} from "./managed-refresh";
import {readAsanaConnection} from "./asana-connection";
const refresh = createManagedTokenRefresher("asana", "Asana", readAsanaConnection);
export const freshAsanaConnection = refresh.fresh;
export const asanaNeedsReconnect = refresh.needsReconnect;
export const asanaGrantKey = refresh.grantKey;
