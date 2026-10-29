import type { JarvisConfig } from "../../config/types";
import {
  ASANA_CONNECTION,
  ASANA_PIECE,
  readAsanaConnection,
} from "../../integrations/asana-connection";
import {
  freshAsanaConnection,
  asanaGrantKey,
  asanaNeedsReconnect,
} from "../../integrations/asana-refresh";
import { MANAGED_ASANA_ACTIONS } from "../runtime/managed-asana";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisAsanaConnectionSource implements JarvisConnectionSource {
  readonly id = "asana";
  readonly pieceNames = [ASANA_PIECE];
  readonly pieceDetails = {
    [ASANA_PIECE]: {
      displayName: "Asana",
      apiHosts: ["app.asana.com"],
      actions: MANAGED_ASANA_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === ASANA_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readAsanaConnection(this.config.daemon.data_dir)
      : null;
    return c && !asanaNeedsReconnect(this.config, c)
      ? asanaGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readAsanaConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshAsanaConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: ASANA_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "asana",
      },
    };
  }
}
