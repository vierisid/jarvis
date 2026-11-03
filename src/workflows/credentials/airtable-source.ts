import type { JarvisConfig } from "../../config/types";
import {
  AIRTABLE_CONNECTION,
  AIRTABLE_PIECE,
  readAirtableConnection,
} from "../../integrations/airtable-connection";
import {
  freshAirtableConnection,
  airtableGrantKey,
  airtableNeedsReconnect,
} from "../../integrations/airtable-refresh";
import { MANAGED_AIRTABLE_ACTIONS } from "../runtime/managed-airtable";
import type { JarvisConnectionSource, ResolvedConnection } from "./adapter";
export class JarvisAirtableConnectionSource implements JarvisConnectionSource {
  readonly id = "airtable";
  readonly pieceNames = [AIRTABLE_PIECE];
  readonly pieceDetails = {
    [AIRTABLE_PIECE]: {
      displayName: "Airtable",
      apiHosts: ["api.airtable.com"],
      actions: MANAGED_AIRTABLE_ACTIONS,
    },
  };
  constructor(
    private readonly config: JarvisConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  canResolve(id: string) {
    return id === AIRTABLE_CONNECTION;
  }
  identity(id: string) {
    const c = this.canResolve(id)
      ? readAirtableConnection(this.config.daemon.data_dir)
      : null;
    return c && !airtableNeedsReconnect(this.config, c)
      ? airtableGrantKey(c)
      : null;
  }
  async resolve(id: string): Promise<ResolvedConnection | null> {
    if (
      !this.canResolve(id) ||
      !readAirtableConnection(this.config.daemon.data_dir)
    )
      return null;
    const c = await freshAirtableConnection(this.config, this.request);
    return {
      type: "SECRET_TEXT",
      pieceName: AIRTABLE_PIECE,
      status: "ACTIVE",
      value: {
        secret_text: c.access_token,
        jarvis_managed: "airtable",
      },
    };
  }
}
