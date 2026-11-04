import type { JarvisConfig } from "../../config/types";
import {
  ZOOM_CONNECTION,
  ZOOM_PIECE,
  readZoomConnection,
} from "../../integrations/zoom-connection";
import {
  freshZoomConnection,
  zoomGrantKey,
  zoomNeedsReconnect,
} from "../../integrations/zoom-refresh";
import { MANAGED_ZOOM_ACTIONS } from "../runtime/managed-zoom";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisZoomConnectionSource implements JarvisConnectionSource {
  readonly id = "zoom";
  readonly pieceNames = [ZOOM_PIECE];
  readonly pieceDetails = {
    [ZOOM_PIECE]: {
      displayName: "Zoom",
      apiHosts: ["api.zoom.us"],
      actions: MANAGED_ZOOM_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === ZOOM_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readZoomConnection(this.config.daemon.data_dir)
      : null;
    return c && !zoomNeedsReconnect(this.config, c) ? zoomGrantKey(c) : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readZoomConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshZoomConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: ZOOM_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "zoom",
        jarvis_user: c.account.id,
      },
    };
  }
}
