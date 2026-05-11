/**
 * `JarvisTelegramConnectionSource` -- bridges Jarvis's existing Telegram
 * bot token (configured in `~/.jarvis/config.yaml` under
 * `channels.telegram.bot_token`) into the workflow runtime's
 * `CredentialResolver`. When a piece asks for `jarvis:telegram`, the source
 * returns the same token Jarvis is using for the inbound bot.
 *
 * The piece sees a `SECRET_TEXT`-shaped value:
 *   { value: <bot-token-string> }
 *
 * This matches activepieces' telegram-bot piece auth shape -- pieces that
 * call `https://api.telegram.org/bot<token>/...` read `auth.value`.
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
      value: { value: token },
    };
  }
}
