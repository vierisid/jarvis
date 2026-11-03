import type { JarvisConfig } from "../../config/types";
import {
  DROPBOX_CONNECTION,
  DROPBOX_PIECE,
  readDropboxConnection,
} from "../../integrations/dropbox-connection";
import {
  freshDropboxConnection,
  dropboxGrantKey,
  dropboxNeedsReconnect,
} from "../../integrations/dropbox-refresh";
import { MANAGED_DROPBOX_ACTIONS } from "../runtime/managed-dropbox";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisDropboxConnectionSource implements JarvisConnectionSource {
  readonly id = "dropbox";
  readonly pieceNames = [DROPBOX_PIECE];
  readonly pieceDetails = {
    [DROPBOX_PIECE]: {
      displayName: "Dropbox",
      apiHosts: ["api.dropboxapi.com"],
      actions: MANAGED_DROPBOX_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === DROPBOX_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readDropboxConnection(this.config.daemon.data_dir)
      : null;
    return c && !dropboxNeedsReconnect(this.config, c)
      ? dropboxGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readDropboxConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshDropboxConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: DROPBOX_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "dropbox",
        home_namespace_id: c.settings.home_namespace_id,
      },
    };
  }
}
