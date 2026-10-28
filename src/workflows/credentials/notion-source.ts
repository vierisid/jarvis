import type { JarvisConfig } from "../../config/types";
import {
  NOTION_CONNECTION,
  NOTION_PIECE,
  readNotionConnection,
} from "../../integrations/notion-connection";
import {
  freshNotionConnection,
  notionGrantKey,
  notionNeedsReconnect,
} from "../../integrations/notion-refresh";
import { MANAGED_NOTION_ACTIONS } from "../runtime/managed-notion";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisNotionConnectionSource implements JarvisConnectionSource {
  readonly id = "notion";
  readonly pieceNames = [NOTION_PIECE];
  readonly pieceDetails = {
    [NOTION_PIECE]: {
      displayName: "Notion",
      apiHosts: ["api.notion.com"],
      actions: MANAGED_NOTION_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === NOTION_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readNotionConnection(this.config.daemon.data_dir)
      : null;
    return c && !notionNeedsReconnect(this.config, c)
      ? notionGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readNotionConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshNotionConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: NOTION_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        jarvis_managed: "notion",
      },
    };
  }
}
