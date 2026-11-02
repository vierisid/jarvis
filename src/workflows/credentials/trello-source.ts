import { TRELLO_CONNECTION, TRELLO_PIECE, readTrelloConnection } from "../../integrations/trello-connection";
import { MANAGED_TRELLO_ACTIONS } from "../runtime/managed-trello";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/**
 * Read through the atomically delivered file. Disconnects need no daemon restart.
 * The community Trello piece takes BASIC_AUTH: username = API key,
 * password = user token.
 */
export class JarvisTrelloConnectionSource implements JarvisConnectionSource {
  readonly id = "trello";
  /** Only Trello steps may name jarvis:trello, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [TRELLO_PIECE];
  /** Only the qualified managed actions, never a trigger or a custom API call
   * (whose base URL would be https://api.trello.com/1/). */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [TRELLO_PIECE]: { displayName: "Trello", apiHosts: ["api.trello.com"], actions: MANAGED_TRELLO_ACTIONS },
  };
  constructor(private readonly dataDir: string) {}
  canResolve(externalId: string) { return externalId === TRELLO_CONNECTION; }
  identity(externalId: string) {
    if (!this.canResolve(externalId)) return null;
    const connection = readTrelloConnection(this.dataDir);
    return connection ? credentialFingerprint(connection.generation + ":" + connection.account.id + ":" + connection.api_key + ":" + connection.access_token) : null;
  }
  async resolve(externalId: string): Promise<ResolvedConnection | null> {
    if (!this.canResolve(externalId)) return null;
    const connection = readTrelloConnection(this.dataDir);
    return connection ? {type: "BASIC_AUTH", pieceName: TRELLO_PIECE, status: "ACTIVE",
      value: {username: connection.api_key, password: connection.access_token, jarvis_managed: "trello"}} : null;
  }
}
