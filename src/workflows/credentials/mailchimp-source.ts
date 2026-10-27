import { MAILCHIMP_CONNECTION, MAILCHIMP_PIECE, readMailchimpConnection } from "../../integrations/mailchimp-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ManagedPieceDetails, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisMailchimpConnectionSource implements JarvisConnectionSource {
  readonly id = "mailchimp";
  /** Only Mailchimp steps may name jarvis:mailchimp, and only as their auth (readiness and the credential route). */
  readonly pieceNames: readonly string[] = [MAILCHIMP_PIECE];
  /**
   * The pinned 0.5.10 piece has no custom API call, and its host depends on the
   * account's data center, so no fixed host is listed: a path is all it may use.
   */
  readonly pieceDetails: Readonly<Record<string, ManagedPieceDetails>> = {
    [MAILCHIMP_PIECE]: { displayName: "Mailchimp", apiHosts: [] },
  };
  constructor(private readonly dataDir: string) {}
  canResolve(externalId: string) { return externalId === MAILCHIMP_CONNECTION; }
  identity(externalId: string) {
    if (!this.canResolve(externalId)) return null;
    const connection = readMailchimpConnection(this.dataDir);
    return connection ? credentialFingerprint(connection.generation + ":" + connection.account.id + ":" + connection.server_prefix + ":" + connection.access_token) : null;
  }
  async resolve(externalId: string): Promise<ResolvedConnection | null> {
    if (!this.canResolve(externalId)) return null;
    const connection = readMailchimpConnection(this.dataDir);
    return connection ? {type: "OAUTH2", pieceName: MAILCHIMP_PIECE, status: "ACTIVE",
      value: {access_token: connection.access_token, token_type: "Bearer", server_prefix: connection.server_prefix, jarvis_managed: "mailchimp"}} : null;
  }
}
