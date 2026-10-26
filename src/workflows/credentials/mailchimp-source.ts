import { MAILCHIMP_CONNECTION, MAILCHIMP_PIECE, readMailchimpConnection } from "../../integrations/mailchimp-connection";
import { credentialFingerprint, type JarvisConnectionSource, type ResolvedConnection } from "./adapter";

/** Read through the atomically delivered file. Disconnects need no daemon restart. */
export class JarvisMailchimpConnectionSource implements JarvisConnectionSource {
  readonly id = "mailchimp";
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
