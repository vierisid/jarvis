import type { JarvisConfig } from "../../config/types";
import {
  TYPEFORM_CONNECTION,
  TYPEFORM_PIECE,
  readTypeformConnection,
} from "../../integrations/typeform-connection";
import {
  freshTypeformConnection,
  typeformGrantKey,
  typeformNeedsReconnect,
} from "../../integrations/typeform-refresh";
import { MANAGED_TYPEFORM_ACTIONS } from "../runtime/managed-typeform";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisTypeformConnectionSource implements JarvisConnectionSource {
  readonly id = "typeform";
  readonly pieceNames = [TYPEFORM_PIECE];
  readonly pieceDetails = {
    [TYPEFORM_PIECE]: {
      displayName: "Typeform",
      apiHosts: ["api.typeform.com", "api.eu.typeform.com"],
      actions: MANAGED_TYPEFORM_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === TYPEFORM_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readTypeformConnection(this.config.daemon.data_dir)
      : null;
    return c && !typeformNeedsReconnect(this.config, c)
      ? typeformGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readTypeformConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshTypeformConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: TYPEFORM_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "typeform",
      },
    };
  }
}
