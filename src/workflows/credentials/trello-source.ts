import { TRELLO_CONNECTION, TRELLO_PIECE, readTrelloConnection } from "../../integrations/trello-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ResolvedConnection } from "./adapter";

/**
 * Read through the atomically delivered file. Disconnects need no daemon restart.
 * The community Trello piece takes BASIC_AUTH: username = API key,
 * password = user token.
 */
export class JarvisTrelloConnectionSource implements JarvisConnectionSource {
  readonly id = "trello";
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
