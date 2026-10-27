import { CLICKUP_CONNECTION, CLICKUP_PIECE, readClickUpConnection } from "../../integrations/clickup-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisClickUpConnectionSource implements JarvisConnectionSource {
  readonly id = "clickup";
  /** Only ClickUp steps may name jarvis:clickup, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [CLICKUP_PIECE];
  /** The piece's custom API call base URL is https://api.clickup.com/api/v2/ in the pinned 0.9.1 bundle. */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [CLICKUP_PIECE]: { displayName: "ClickUp", apiHosts: ["api.clickup.com"] },
  };
  constructor(private readonly dataDir: string) {}
  canResolve(externalId: string) { return externalId === CLICKUP_CONNECTION; }
  identity(externalId: string) {
    if (!this.canResolve(externalId)) return null;
    const connection = readClickUpConnection(this.dataDir);
    return connection ? credentialFingerprint(connection.generation + ":" + connection.account.id + ":" + connection.access_token) : null;
  }
  async resolve(externalId: string): Promise<ResolvedConnection | null> {
    if (!this.canResolve(externalId)) return null;
    const connection = readClickUpConnection(this.dataDir);
    return connection ? {type: "OAUTH2", pieceName: CLICKUP_PIECE, status: "ACTIVE",
      value: {access_token: connection.access_token, refresh_token: "", token_type: "Bearer"}} : null;
  }
}
