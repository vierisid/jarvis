import {
  notionJson,
  NotionRequestError,
} from "../workflows/runtime/managed-notion";
import { createManagedRotatingRefresher } from "./managed-rotating-refresh";
import { readNotionConnection } from "./notion-connection";
const refresh = createManagedRotatingRefresher(
  "notion",
  "Notion",
  readNotionConnection,
  {
    allowUnknownExpiry: true,
    validateAccess: async (c, request) => {
      try {
        const bot = await notionJson("users/me", c.access_token, {}, request);
        if (!bot || bot.type !== "bot" || bot.id !== c.account.id)
          throw new Error("Notion account changed. Reconnect Notion.");
        return true;
      } catch (error) {
        if (error instanceof NotionRequestError && error.status === 401)
          return false;
        throw error;
      }
    },
  },
);
export const freshNotionConnection = refresh.fresh;
export const notionNeedsReconnect = refresh.needsReconnect;
export const notionGrantKey = refresh.grantKey;
