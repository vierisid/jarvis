import type { JarvisConfig } from "../../config/types";
import {
  HELP_SCOUT_CONNECTION,
  HELP_SCOUT_PIECE,
  readHelpScoutConnection,
} from "../../integrations/help-scout-connection";
import {
  freshHelpScoutConnection,
  helpScoutGrantKey,
  helpScoutNeedsReconnect,
} from "../../integrations/help-scout-refresh";
import { MANAGED_HELP_SCOUT_ACTIONS } from "../runtime/managed-help-scout";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisHelpScoutConnectionSource implements JarvisConnectionSource {
  readonly id = "help-scout";
  readonly pieceNames = [HELP_SCOUT_PIECE];
  readonly pieceDetails = {
    [HELP_SCOUT_PIECE]: {
      displayName: "Help Scout",
      apiHosts: ["api.helpscout.net"],
      actions: MANAGED_HELP_SCOUT_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === HELP_SCOUT_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readHelpScoutConnection(this.config.daemon.data_dir)
      : null;
    return c && !helpScoutNeedsReconnect(this.config, c)
      ? helpScoutGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readHelpScoutConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshHelpScoutConnection(this.config, this.request);
    return {
      type: "OAUTH2",
      pieceName: HELP_SCOUT_PIECE,
      status: "ACTIVE",
      value: {
        access_token: c.access_token,
        token_type: "Bearer",
        refresh_token: "",
        jarvis_managed: "help-scout",
        jarvis_user: c.account.id,
      },
    };
  }
}
