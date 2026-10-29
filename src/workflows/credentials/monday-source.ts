import type { JarvisConfig } from "../../config/types";
import {
  MONDAY_CONNECTION,
  MONDAY_PIECE,
  readMondayConnection,
} from "../../integrations/monday-connection";
import {
  freshMondayConnection,
  mondayGrantKey,
  mondayNeedsReconnect,
} from "../../integrations/monday-refresh";
import { MANAGED_MONDAY_ACTIONS } from "../runtime/managed-monday";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisMondayConnectionSource implements JarvisConnectionSource {
  readonly id = "monday";
  readonly pieceNames = [MONDAY_PIECE];
  readonly pieceDetails = {
    [MONDAY_PIECE]: {
      displayName: "monday.com",
      apiHosts: ["api.monday.com"],
      actions: MANAGED_MONDAY_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === MONDAY_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readMondayConnection(this.config.daemon.data_dir)
      : null;
    return c && !mondayNeedsReconnect(this.config, c)
      ? mondayGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readMondayConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshMondayConnection(this.config, this.request);
    return {
      type: "SECRET_TEXT",
      pieceName: MONDAY_PIECE,
      status: "ACTIVE",
      value: {
        secret_text: c.access_token,

        jarvis_managed: "monday",
      },
    };
  }
}
