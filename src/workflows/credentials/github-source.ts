import { GITHUB_CONNECTION, GITHUB_PIECE, readGitHubConnection } from "../../integrations/github-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisGitHubConnectionSource implements JarvisConnectionSource {
  readonly id = "github";
  /** Only GitHub steps may name jarvis:github, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [GITHUB_PIECE];
  /**
   * The piece's custom API call base URL is https://api.github.com in the pinned
   * 0.7.3 bundle. The managed action list (managed-github.ts) still refuses a
   * custom API call at readiness and dispatch; this only bounds the token's host.
   */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [GITHUB_PIECE]: { displayName: "GitHub", apiHosts: ["api.github.com"] },
  };
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
