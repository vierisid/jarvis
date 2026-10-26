import { GITHUB_CONNECTION, GITHUB_PIECE, readGitHubConnection } from "../../integrations/github-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisGitHubConnectionSource implements JarvisConnectionSource {
  readonly id = "github";
  readonly pieceNames = [GITHUB_PIECE];
  constructor(private readonly dataDir: string) {}
  canResolve(externalId: string) { return externalId === GITHUB_CONNECTION; }
  identity(externalId: string) {
    if (!this.canResolve(externalId)) return null;
    const connection = readGitHubConnection(this.dataDir);
    return connection ? credentialFingerprint(connection.generation + ":" + connection.account.id + ":" + connection.access_token) : null;
  }
  async resolve(externalId: string): Promise<ResolvedConnection | null> {
    if (!this.canResolve(externalId)) return null;
    const connection = readGitHubConnection(this.dataDir);
    return connection ? {type: "OAUTH2", pieceName: GITHUB_PIECE, status: "ACTIVE",
      value: {access_token: connection.access_token, token_type: "Bearer", jarvis_managed: "github"}} : null;
  }
}
