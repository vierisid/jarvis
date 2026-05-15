/**
 * Hand-written override layer for the pieces catalog.
 *
 * The generated catalog (`catalog-generated.ts`) is the auto-discovered list
 * of every `@activepieces/piece-*` package known to upstream. This file is
 * where humans intervene:
 *
 *   - `VERIFIED`         Promote a piece to the "verified" tier (default is
 *                        "community"). Verified entries are shown without the
 *                        "third-party code" preamble in the UI. Each id added
 *                        here should have had a hands-on smoke test + an
 *                        engine end-to-end check first; see README step 5.
 *   - `EXCLUDED`         Pieces we never want to ship -- deprecated upstream,
 *                        known to crash on import, license issues, etc.
 *                        These are dropped from the final CATALOG entirely.
 *   - `VERSION_PIN`      Hold-back pins for pieces whose latest release is
 *                        broken. Overrides the generated versionRange +
 *                        vettedVersion. Drop the entry once the next upstream
 *                        release fixes the issue.
 *   - `SIZE_OVERRIDE`    Hand-measured `estimatedSizeMb`. The sync script
 *                        can't probe sizes without doing a real bun install
 *                        per piece (slow + flaky in CI), so verified pieces
 *                        get a manual number here. Community pieces ship with
 *                        no size estimate until someone fills one in.
 *   - `DESCRIPTION_OVERRIDE` Cleaner descriptions for pieces whose upstream
 *                        package.json description is missing or unhelpful.
 *
 * Edit policy:
 *   - This file is hand-edited; it does NOT get rewritten by the sync action.
 *   - Adding to VERIFIED is the only thing that requires reviewer attention
 *     beyond the usual "does this compile" -- it's a trust assertion.
 */

/**
 * Verified pieces. Each id below has been smoke-tested + run end-to-end
 * through the engine. Adding to this set is the trust boundary: by listing
 * an id here, you're claiming the piece's source has been read and its
 * basic actions verified against the Jarvis runtime.
 *
 * Promotion checklist:
 *   1. Install the piece (`bun run scripts/install-piece.ts <id>` or via UI).
 *   2. Read the piece's `src/index.ts` -- look for unexpected network calls,
 *      eval, child_process spawns, file system writes outside the sandbox.
 *   3. Run an action that exercises the piece's most-used capability (e.g.
 *      gmail.send_email) through the engine via /api/workflows/:id/run.
 *   4. Land the id here + add a vettedAt entry in VERIFIED_METADATA below
 *      with the date you ran the checks.
 */
export const VERIFIED: ReadonlySet<string> = new Set<string>([
  "gmail",
  "slack",
  "notion",
  "openai",
  "github",
  "google-calendar",
  "google-drive",
  "discord",
  "telegram-bot",
  "claude",
]);

/**
 * Verified-only metadata. Keys MUST also appear in VERIFIED above (the merge
 * layer enforces this). `vettedAt` is the most recent date someone ran the
 * promotion checklist for that id.
 */
export const VERIFIED_METADATA: Record<string, { vettedAt: string }> = {
  gmail:            { vettedAt: "2026-05-11" },
  slack:            { vettedAt: "2026-05-11" },
  notion:           { vettedAt: "2026-05-11" },
  openai:           { vettedAt: "2026-05-11" },
  github:           { vettedAt: "2026-05-11" },
  "google-calendar":{ vettedAt: "2026-05-11" },
  "google-drive":   { vettedAt: "2026-05-11" },
  discord:          { vettedAt: "2026-05-11" },
  "telegram-bot":   { vettedAt: "2026-05-11" },
  claude:           { vettedAt: "2026-05-11" },
};

/**
 * Pieces we explicitly DON'T ship. Reasons documented inline so future
 * reviewers know whether the exclusion is still warranted.
 */
export const EXCLUDED: ReadonlySet<string> = new Set<string>([
  // (empty -- add ids with a comment explaining why)
]);

/**
 * Hold-back pins. Each entry forces a specific versionRange + vettedVersion
 * regardless of what the sync script discovered on npm. Use sparingly --
 * pinning means you're now responsible for unpinning when the upstream fix
 * lands.
 *
 * Example:
 *   "some-piece": { versionRange: "~0.4.0", vettedVersion: "0.4.7", reason: "0.5 throws on init" }
 */
export const VERSION_PIN: Record<
  string,
  { versionRange: string; vettedVersion: string; reason: string }
> = {
  // github 0.6 line never made it to npm even though it was in the
  // monorepo's package.json; npm tops out at 0.6.7. Force the working 0.7.
  github: {
    versionRange: "^0.7.0",
    vettedVersion: "0.7.3",
    reason: "0.6.x in monorepo never published to npm",
  },
  // telegram-bot's 0.6.x line never reached npm; latest there is 0.5.7.
  "telegram-bot": {
    versionRange: "^0.5.0",
    vettedVersion: "0.5.7",
    reason: "0.6.x not published to npm",
  },
};

/**
 * Hand-measured disk-after-install sizes. The sync script doesn't probe
 * because it'd have to `bun install` 300 pieces in CI -- way too slow + flaky.
 * Filling these in is a separate maintenance task; see
 * `scripts/probe-piece-sizes.ts` (future) for batch measurement.
 */
export const SIZE_OVERRIDE: Record<string, number> = {
  gmail: 165,            // googleapis transitive weight
  "google-calendar": 150,
  "google-drive": 160,
  slack: 70,
  openai: 60,
  notion: 55,
  claude: 50,
  github: 45,
  discord: 40,
  "telegram-bot": 40,
};

/**
 * Cleaner descriptions for pieces whose upstream package.json description is
 * missing, generic ("activepieces piece"), or otherwise unhelpful. Empty by
 * default -- add as you notice ones that need help.
 */
export const DESCRIPTION_OVERRIDE: Record<string, string> = {
  gmail:
    "Send + read email through the Gmail API. Requires a Google OAuth connection.",
  slack:
    "Post messages, read channels, react to events. Requires a Slack bot token.",
  notion:
    "Read and write Notion pages / databases. Requires a Notion integration token.",
  openai:
    "Chat completions, embeddings, image generation via the OpenAI API.",
  github:
    "Create issues, comment on PRs, read repository data. Requires a personal access token.",
  "google-calendar":
    "List, create, and update calendar events. Requires a Google OAuth connection.",
  "google-drive":
    "Upload, search, and download files in Google Drive. Requires a Google OAuth connection.",
  discord:
    "Post messages to Discord channels and react to webhook events.",
  "telegram-bot":
    "Send messages and react to Telegram bot updates. Requires a bot token.",
  claude: "Chat completions via the Anthropic Claude API.",
};
