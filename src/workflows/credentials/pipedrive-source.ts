import type { JarvisConfig } from "../../config/types";
import {
  PIPEDRIVE_CONNECTION,
  PIPEDRIVE_PIECE,
  readPipedriveConnection,
} from "../../integrations/pipedrive-connection";
import {
  freshPipedriveConnection,
  pipedriveGrantKey,
  pipedriveNeedsReconnect,
} from "../../integrations/pipedrive-refresh";
import { MANAGED_PIPEDRIVE_ACTIONS } from "../runtime/managed-pipedrive";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisPipedriveConnectionSource implements JarvisConnectionSource {
  readonly id = "pipedrive";
  readonly pieceNames = [PIPEDRIVE_PIECE];
  readonly pieceDetails = {
    [PIPEDRIVE_PIECE]: {
      displayName: "Pipedrive",
      apiHosts: ["*.pipedrive.com"],
      actions: MANAGED_PIPEDRIVE_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === PIPEDRIVE_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readPipedriveConnection(this.config.daemon.data_dir)
      : null;
    return c && !pipedriveNeedsReconnect(this.config, c)
      ? pipedriveGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readPipedriveConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshPipedriveConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: PIPEDRIVE_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        api_host: c.settings.api_host,
        jarvis_managed: "pipedrive",
      },
    };
  }
}
