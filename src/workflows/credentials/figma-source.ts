import type { JarvisConfig } from "../../config/types";
import {
  FIGMA_CONNECTION,
  FIGMA_PIECE,
  readFigmaConnection,
} from "../../integrations/figma-connection";
import {
  freshFigmaConnection,
  figmaGrantKey,
  figmaNeedsReconnect,
} from "../../integrations/figma-refresh";
import { MANAGED_FIGMA_ACTIONS } from "../runtime/managed-figma";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisFigmaConnectionSource implements JarvisConnectionSource {
  readonly id = "figma";
  readonly pieceNames = [FIGMA_PIECE];
  readonly pieceDetails = {
    [FIGMA_PIECE]: {
      displayName: "Figma",
      apiHosts: ["api.figma.com"],
      actions: MANAGED_FIGMA_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === FIGMA_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readFigmaConnection(this.config.daemon.data_dir)
      : null;
    return c && !figmaNeedsReconnect(this.config, c) ? figmaGrantKey(c) : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readFigmaConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshFigmaConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: FIGMA_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "figma",
      },
    };
  }
}
