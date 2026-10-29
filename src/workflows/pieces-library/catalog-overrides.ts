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
 *   - `EXCLUDED`         Pieces we never ship, as id -> reason -- deprecated
 *                        upstream, known to crash on import, license issues,
 *                        etc. Dropped from the final CATALOG entirely, so no
 *                        Library offers them and installPiece refuses them,
 *                        hosted or self-managed.
 *   - `SHARED_BUILD_EXCLUDED` Pieces left out of the hosted shared tree only,
 *                        because the license policy denies something they
 *                        install (#971). Self-managed users can still install
 *                        them.
 *   - `VERSION_PIN`      Hold-back pins for pieces whose latest release is
 *                        broken. Overrides the generated versionRange +
 *                        vettedVersion. Drop the entry once the next upstream
 *                        release fixes the issue.
 *   - `VERIFIED_UPGRADE_REVIEWED` Sign-offs for verified bumps the sync held
 *                        for a raised classification or removed props.
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
 *   5. Land a governed adapter for it in
 *      `src/workflows/runtime/piece-effects.ts`, so its actions carry an
 *      Authority category and a reviewable target. Verified means vetted AND
 *      governed; every id below has one.
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
 * Pieces we explicitly DON'T ship, anywhere, as id -> reason. The reason is
 * what installPiece refuses with and what a self-managed Library shows on a
 * row someone installed before the exclusion, so write it for that person.
 *
 * An excluded id stays in catalog-generated.ts: that file is the upstream
 * list, rewritten by the weekly sync, and the merge in catalog.ts drops these
 * ids from it every time. The sync never edits this file, so it cannot bring
 * one back.
 *
 * An install that already has one keeps it (the reconciler still installs
 * what the manifest declares and flows that use it keep running); the
 * Library lists it as withdrawn with this reason and offers only Uninstall.
 */
export const EXCLUDED: Readonly<Record<string, string>> = {
  // Owner decision 2026-10-23: out everywhere, not only from the hosted
  // shared tree (#971). Measured on the full catalog install 2026-10-21.
  actualbudget:
    "Actual Budget is no longer offered: @activepieces/piece-actualbudget@0.1.9 > @actual-app/api@26.5.2 > " +
    "@actual-app/core@26.5.2 pulls hyperformula@3.5.0 (GPL-3.0-only) and ua-parser-js@2.0.10 " +
    "(AGPL-3.0-or-later), which the Jarvis license policy does not allow (#971).",
};

/**
 * Pieces left out of the HOSTED shared tree only, as id -> reason (#971).
 * scripts/build-shared-runtime.ts fails on any package the license policy
 * denies, because that tree is what we run for every tenant. A piece listed
 * here is not installed there and not offered in a host-managed Library; a
 * self-managed user can still install it, from npm, onto their own machine.
 * Each reason names the packages and the chain that put it here, so a later
 * catalog sync can tell when it no longer holds. A piece that should not be
 * offered anywhere belongs in EXCLUDED instead, which the shared build also
 * leaves out (and reports).
 */
export const SHARED_BUILD_EXCLUDED: Readonly<Record<string, string>> = {
  // (empty -- add ids with the measured dependency chain as the reason)
};

/**
 * Verified upgrades a person has read and signed off, as id -> version.
 *
 * The catalog sync bumps a verified piece by itself when its governed adapter
 * still covers the new version (see `scripts/lib/verified-upgrade.ts`). Two
 * findings hold a bump for a person instead: an existing action whose upstream
 * classification got more severe, and an existing action that lost props. Once
 * you have checked the adapter still fits, add the version here and the next
 * sync run takes it. Unmapped actions are NOT cleared by this: map them.
 *
 * Example:
 *   gmail: "0.18.0",
 */
export const VERIFIED_UPGRADE_REVIEWED: Record<string, string> = {
  // (empty -- add entries when the review issue asks for one)
};

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
  figma: {versionRange: "0.6.3", vettedVersion: "0.6.3", reason: "Managed OAuth file/comment actions and output wrappers qualified in the real engine; review before upgrading"},
  asana: {versionRange: "0.7.2", vettedVersion: "0.7.2", reason: "Managed OAuth and five governed task actions qualified against the real engine; review before upgrading"},
  dropbox: {versionRange: "0.9.2", vettedVersion: "0.9.2", reason: "Governed action table (MANAGED_PIECE_ADAPTERS), managed action contracts and outputs mapped against 0.9.2; review before upgrading"},
  mailchimp: {versionRange: "0.5.10", vettedVersion: "0.5.10", reason: "Five managed subscriber, tag and reporting actions qualified against 0.5.10; review before upgrading"},
  slack: {versionRange: "0.23.1", vettedVersion: "0.23.1", reason: "Managed bot connection actions qualified against 0.23.1; review before upgrading"},
  clickup: {versionRange: "0.9.1", vettedVersion: "0.9.1", reason: "Governed action table (MANAGED_PIECE_ADAPTERS) and task outputs mapped against 0.9.1; review before upgrading"},
  // github 0.6 line never made it to npm even though it was in the
  // monorepo's package.json; npm tops out at 0.6.7. Force the working 0.7.
  // Both are verified pieces, so the range is the exact vetted version like
  // every other verified entry; the pin only exists to move off the
  // unpublished line.
  github: {
    versionRange: "0.7.3",
    vettedVersion: "0.7.3",
    reason: "0.6.x in monorepo never published to npm",
  },
  // telegram-bot's 0.6.x line never reached npm; latest there is 0.5.7.
  "telegram-bot": {
    versionRange: "0.5.7",
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
