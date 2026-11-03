import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readTodoistConnection } from "./todoist-connection";
const refresh = createManagedRotatingRefresher(
  "todoist",
  "Todoist",
  readTodoistConnection,
);
export const freshTodoistConnection = refresh.fresh;
export const todoistNeedsReconnect = refresh.needsReconnect;
export const todoistGrantKey = refresh.grantKey;
