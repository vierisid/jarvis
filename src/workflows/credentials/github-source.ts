import { GITHUB_CONNECTION, GITHUB_PIECE, readGitHubConnection } from "../../integrations/github-connection";
import { MANAGED_GITHUB_ACTIONS } from "../runtime/managed-github";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisGitHubConnectionSource implements JarvisConnectionSource {
  readonly id = "github";
  /** Only GitHub steps may name jarvis:github, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [GITHUB_PIECE];
  /**
   * Only the managed issue actions (managed-github.ts) may be handed the token,
   * at readiness and at the credential route, so a graph that skipped readiness
   * cannot reach it from a trigger hook or a custom API call either. The host
   * still bounds the token should a custom API call ever be qualified.
   */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [GITHUB_PIECE]: { displayName: "GitHub", actions: MANAGED_GITHUB_ACTIONS, apiHosts: ["api.github.com"] },
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
