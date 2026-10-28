import { SLACK_CONNECTION, SLACK_PIECE, readSlackConnection } from "../../integrations/slack-connection";
import { MANAGED_SLACK_ACTIONS } from "../runtime/managed-slack";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisSlackConnectionSource implements JarvisConnectionSource {
  readonly id = "slack";
  /** Only Slack steps may name jarvis:slack, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [SLACK_PIECE];
  /**
   * Only the managed Slack actions (managed-slack.ts) may be handed the token,
   * at readiness and at the credential route, so a graph that skipped readiness
   * cannot reach it from a trigger hook or a custom API call either. The host
   * (the piece's custom API call base URL is https://slack.com/api in the pinned
   * 0.23.1 bundle) still bounds the token should a custom API call ever be qualified.
   */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [SLACK_PIECE]: { displayName: "Slack", actions: MANAGED_SLACK_ACTIONS, apiHosts: ["slack.com"] },
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
