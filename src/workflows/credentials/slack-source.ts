import { SLACK_CONNECTION, SLACK_PIECE, readSlackConnection } from "../../integrations/slack-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisSlackConnectionSource implements JarvisConnectionSource {
  readonly id = "slack";
  /** Only Slack steps may name jarvis:slack, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [SLACK_PIECE];
  /** The piece's custom API call base URL is https://slack.com/api in the pinned 0.23.1 bundle. */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [SLACK_PIECE]: { displayName: "Slack", apiHosts: ["slack.com"] },
  };
  constructor(private readonly dataDir: string) {}
  canResolve(externalId: string) { return externalId === SLACK_CONNECTION; }
  identity(externalId: string) {
    if (!this.canResolve(externalId)) return null;
    const connection = readSlackConnection(this.dataDir);
    return connection ? credentialFingerprint(connection.generation + ":" + connection.account.id + ":" + connection.access_token) : null;
  }
  async resolve(externalId: string): Promise<ResolvedConnection | null> {
    if (!this.canResolve(externalId)) return null;
    const connection = readSlackConnection(this.dataDir);
    return connection ? {type: "OAUTH2", pieceName: SLACK_PIECE, status: "ACTIVE",
      value: {access_token: connection.access_token, refresh_token: "", token_type: "bot", scope: connection.scopes.join(","),
        data: {team: connection.workspaces[0], bot_user_id: connection.account.id, jarvis_managed: "slack"}}} : null;
  }
}
