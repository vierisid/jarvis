import {
  WEBFLOW_CONNECTION,
  WEBFLOW_PIECE,
  readWebflowConnection,
} from "../../integrations/webflow-connection";
import { MANAGED_WEBFLOW_ACTIONS } from "../runtime/managed-webflow";
import {
  credentialFingerprint,
  type JarvisConnectionSource,
  type ManagedPieceDetails,
  type ResolvedConnection,
} from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisWebflowConnectionSource implements JarvisConnectionSource {
  readonly id = "webflow";
  /** Only Webflow steps may name jarvis:webflow, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [WEBFLOW_PIECE];
  /**
   * Only the managed CMS actions (managed-webflow.ts) may be handed the token,
   * at readiness and at the credential route, so a graph that skipped readiness
   * cannot reach it from a trigger hook or a custom API call either. The host
   * still bounds the token should a custom API call ever be qualified.
   */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [WEBFLOW_PIECE]: {
      displayName: "Webflow",
      actions: MANAGED_WEBFLOW_ACTIONS,
      apiHosts: ["api.webflow.com"],
    },
  };
  constructor(private readonly dataDir: string) {}
  canResolve(externalId: string) {
    return externalId === WEBFLOW_CONNECTION;
  }
  identity(externalId: string) {
    if (!this.canResolve(externalId)) return null;
    const connection = readWebflowConnection(this.dataDir);
    return connection
      ? credentialFingerprint(
          JSON.stringify([
            connection.generation,
            connection.account.id,
            connection.access_token,
            connection.workspaces.map((w) => w.id),
          ]),
        )
      : null;
  }
  async resolve(externalId: string): Promise<ResolvedConnection | null> {
    if (!this.canResolve(externalId)) return null;
    const connection = readWebflowConnection(this.dataDir);
    return connection
      ? {
          type: "OAUTH2",
          pieceName: WEBFLOW_PIECE,
          status: "ACTIVE",
          value: {
            access_token: connection.access_token,
            token_type: "Bearer",
            jarvis_managed: "webflow",
            webflow_site_ids: connection.workspaces.map((w) => w.id),
          },
        }
      : null;
  }
}
