/**
 * `JarvisTelegramConnectionSource` -- bridges Jarvis's existing Telegram
 * bot token (configured in `~/.jarvis/config.yaml` under
 * `channels.telegram.bot_token`) into the workflow runtime's
 * `CredentialResolver`. When a piece asks for `jarvis:telegram`, the source
 * returns the same token Jarvis is using for the inbound bot.
 *
 * The piece sees a `SECRET_TEXT`-shaped value:
 *   { secret_text: <bot-token-string> }
 *
 * This matches the engine's V0-context unwrap in
 * `connection-resolver.ts:makeConnectionValueCompatibleWithContextV0`, which
 * reads `connection.value.secret_text` for SECRET_TEXT auth. V1-context
 * pieces receive the same object verbatim. Activepieces' telegram-bot piece
 * sees the raw token string in V0 mode and `auth.secret_text` in V1.
 *
 * If Telegram isn't configured (token missing or empty), `resolve` returns
 * null so the credential resolver falls through to the user's manually-
 * created `app_connection` row, if any.
 */

import type {
  JarvisConnectionSource,
  ResolvedConnection,
} from "./adapter";

export const JARVIS_TELEGRAM_PREFIX = "jarvis:telegram";

export class JarvisTelegramConnectionSource implements JarvisConnectionSource {
  readonly id = "telegram";

  /**
   * Token supplier. Closes over the daemon's config so changes (e.g., user
   * rotates the bot token + restarts) take effect without rebuilding the
   * source. Returns null when telegram isn't configured.
   */
  constructor(private readonly getToken: () => string | null) {}

  canResolve(externalId: string): boolean {
    return externalId === JARVIS_TELEGRAM_PREFIX || externalId.startsWith(`${JARVIS_TELEGRAM_PREFIX}:`);
  }

  async resolve(_externalId: string): Promise<ResolvedConnection | null> {
    const token = this.getToken();
    if (!token) return null;
    return {
      type: "SECRET_TEXT",
      value: { secret_text: token },
    };
  }
}
