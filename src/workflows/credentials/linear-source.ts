import type { JarvisConfig } from "../../config/types";
import {
  LINEAR_CONNECTION,
  LINEAR_PIECE,
  readLinearConnection,
} from "../../integrations/linear-connection";
import {
  freshLinearConnection,
  linearGrantKey,
  linearNeedsReconnect,
} from "../../integrations/linear-refresh";
import { MANAGED_LINEAR_ACTIONS } from "../runtime/managed-linear";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisLinearConnectionSource implements JarvisConnectionSource {
  readonly id = "linear";
  readonly pieceNames = [LINEAR_PIECE];
  readonly pieceDetails = {
    [LINEAR_PIECE]: {
      displayName: "Linear",
      apiHosts: ["api.linear.app"],
      actions: MANAGED_LINEAR_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === LINEAR_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readLinearConnection(this.config.daemon.data_dir)
      : null;
    return c && !linearNeedsReconnect(this.config, c)
      ? linearGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readLinearConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshLinearConnection(this.config, this.request);
    return {
      type: "SECRET_TEXT",
      pieceName: LINEAR_PIECE,
      status: "ACTIVE",
      value: {
        secret_text: c.access_token,

        jarvis_managed: "linear",
      },
    };
  }
}
