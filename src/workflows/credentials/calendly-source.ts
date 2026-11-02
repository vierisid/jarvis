import type { JarvisConfig } from "../../config/types";
import {
  CALENDLY_CONNECTION,
  CALENDLY_PIECE,
  readCalendlyConnection,
} from "../../integrations/calendly-connection";
import {
  freshCalendlyConnection,
  calendlyGrantKey,
  calendlyNeedsReconnect,
} from "../../integrations/calendly-refresh";
import { MANAGED_CALENDLY_ACTIONS } from "../runtime/managed-calendly";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisCalendlyConnectionSource implements JarvisConnectionSource {
  readonly id = "calendly";
  readonly pieceNames = [CALENDLY_PIECE];
  readonly pieceDetails = {
    [CALENDLY_PIECE]: {
      displayName: "Calendly",
      apiHosts: ["api.calendly.com"],
      actions: MANAGED_CALENDLY_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === CALENDLY_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readCalendlyConnection(this.config.daemon.data_dir)
      : null;
    return c && !calendlyNeedsReconnect(this.config, c)
      ? calendlyGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readCalendlyConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshCalendlyConnection(this.config, this.request);
    return {
      type: "SECRET_TEXT",
      pieceName: CALENDLY_PIECE,
      status: "ACTIVE",
      value: {
        secret_text: c.access_token,
        jarvis_user: c.account.id,
        jarvis_managed: "calendly",
      },
    };
  }
}
