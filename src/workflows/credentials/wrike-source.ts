import type { JarvisConfig } from "../../config/types";
import {
  WRIKE_CONNECTION,
  WRIKE_PIECE,
  readWrikeConnection,
} from "../../integrations/wrike-connection";
import {
  freshWrikeConnection,
  wrikeGrantKey,
  wrikeNeedsReconnect,
} from "../../integrations/wrike-refresh";
import { MANAGED_WRIKE_ACTIONS } from "../runtime/managed-wrike";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisWrikeConnectionSource implements JarvisConnectionSource {
  readonly id = "wrike";
  readonly pieceNames = [WRIKE_PIECE];
  readonly pieceDetails = {
    [WRIKE_PIECE]: {
      displayName: "Wrike",
      apiHosts: ["www.wrike.com", "app-us2.wrike.com", "app-eu.wrike.com"],
      actions: MANAGED_WRIKE_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === WRIKE_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readWrikeConnection(this.config.daemon.data_dir)
      : null;
    return c && !wrikeNeedsReconnect(this.config, c) ? wrikeGrantKey(c) : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readWrikeConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshWrikeConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: WRIKE_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        api_host: c.settings.api_host,

        jarvis_managed: "wrike",
      },
    };
  }
}
