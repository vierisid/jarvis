/**
 * Curated list of activepieces community pieces that Jarvis users can
 * install at runtime via the Library tab. See `./README.md` for the policy
 * around pin style (`^` vs `~`), how to add / update / remove entries, and
 * the trust model.
 *
 * Adding to this list requires running the bun smoke test (README step 2)
 * AND the engine end-to-end check (README step 5). Don't just paste
 * something in from a hunch -- the catalog is the trust boundary.
 */

export interface CatalogEntry {
  /**
   * Stable Jarvis-side id. URL slug, manifest key. NEVER rename once shipped --
   * existing installs reference pieces by this id and would orphan on rename.
   */
  id: string;
  /** npm package name resolved at install time. */
  npmPackage: string;
  /**
   * Semver range bun resolves against. Default convention is `^x.y.z` (caret).
   * Use `~x.y.z` (tilde) for patch-only floats, or a bare `x.y.z` (exact pin)
   * when a specific version is broken and we need to hold back. See README.
   */
  versionRange: string;
  displayName: string;
  description: string;
  iconUrl?: string;
  /** ISO date of the most recent manual audit. */
  vettedAt: string;
  /** Exact version Jarvis last tested end-to-end. */
  vettedVersion: string;
  sourceUrl: string;
  /** SPDX identifier for the piece's own license (deps may differ). */
  licenseSpdx: string;
  /**
   * Approximate on-disk size of the piece + its transitive deps after
   * `bun install`, in megabytes. Surfaced in the Library UI so users can
   * see the disk cost before clicking Install (gmail's googleapis dep
   * pulls ~165MB; openai is leaner). Measured manually during vetting --
   * the README has the procedure. Omit when unknown; the UI hides the
   * footprint badge in that case.
   */
  estimatedSizeMb?: number;
}

/**
 * Initial entries are deliberately a small, well-trusted set. New pieces
 * follow the README's "Adding a new piece" checklist before landing here.
 *
 * Each entry below was smoke-tested with the bun version pinned in this
 * repo's `package.json` engines field at vettedAt.
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: "gmail",
    npmPackage: "@activepieces/piece-gmail",
    versionRange: "^0.12.2",
    displayName: "Gmail",
    description:
      "Send + read email through the Gmail API. Requires a Google OAuth connection.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.12.3",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/gmail",
    licenseSpdx: "MIT",
    // googleapis pulls a lot of transitive types + API surfaces.
    estimatedSizeMb: 165,
  },
  {
    id: "slack",
    npmPackage: "@activepieces/piece-slack",
    versionRange: "^0.16.4",
    displayName: "Slack",
    description:
      "Post messages, read channels, react to events. Requires a Slack bot token.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.16.5",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/slack",
    licenseSpdx: "MIT",
    estimatedSizeMb: 70,
  },
  {
    id: "notion",
    npmPackage: "@activepieces/piece-notion",
    versionRange: "^0.6.1",
    displayName: "Notion",
    description:
      "Read and write Notion pages / databases. Requires a Notion integration token.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.6.1",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/notion",
    licenseSpdx: "MIT",
    estimatedSizeMb: 55,
  },
  {
    id: "openai",
    npmPackage: "@activepieces/piece-openai",
    versionRange: "^0.7.5",
    displayName: "OpenAI",
    description:
      "Chat completions, embeddings, image generation via the OpenAI API.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.7.5",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/openai",
    licenseSpdx: "MIT",
    estimatedSizeMb: 60,
  },
  {
    id: "github",
    // The original 0.6.8 pin was taken from the vendored package.json but
    // never made it to npm; the 0.6 line topped out at 0.6.7. Re-vetted
    // against the live registry at ^0.7.0.
    npmPackage: "@activepieces/piece-github",
    versionRange: "^0.7.0",
    displayName: "GitHub",
    description:
      "Create issues, comment on PRs, read repository data. Requires a personal access token.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.7.3",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/github",
    licenseSpdx: "MIT",
    estimatedSizeMb: 45,
  },
  {
    id: "google-calendar",
    npmPackage: "@activepieces/piece-google-calendar",
    versionRange: "^0.6.0",
    displayName: "Google Calendar",
    description:
      "List, create, and update calendar events. Requires a Google OAuth connection.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.6.7",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/google-calendar",
    licenseSpdx: "MIT",
    // googleapis is the bulk -- shares transitive footprint with gmail.
    estimatedSizeMb: 150,
  },
  {
    id: "google-drive",
    npmPackage: "@activepieces/piece-google-drive",
    versionRange: "^0.7.0",
    displayName: "Google Drive",
    description:
      "Upload, search, and download files in Google Drive. Requires a Google OAuth connection.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.7.5",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/google-drive",
    licenseSpdx: "MIT",
    // Same googleapis footprint.
    estimatedSizeMb: 160,
  },
  {
    id: "discord",
    npmPackage: "@activepieces/piece-discord",
    versionRange: "^0.4.0",
    displayName: "Discord",
    description:
      "Post messages to Discord channels and react to webhook events.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.4.4",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/discord",
    licenseSpdx: "MIT",
    estimatedSizeMb: 40,
  },
  {
    id: "telegram-bot",
    // The original 0.6.x pin came from the vendored package.json but the
    // public npm release line stops at 0.5.x. Re-vetted against ^0.5.0.
    npmPackage: "@activepieces/piece-telegram-bot",
    versionRange: "^0.5.0",
    displayName: "Telegram Bot",
    description:
      "Send messages and react to Telegram bot updates. Requires a bot token.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.5.7",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/telegram-bot",
    licenseSpdx: "MIT",
    estimatedSizeMb: 40,
  },
  {
    id: "claude",
    npmPackage: "@activepieces/piece-claude",
    versionRange: "^0.3.0",
    displayName: "Anthropic Claude",
    description:
      "Chat completions via the Anthropic Claude API.",
    vettedAt: "2026-05-11",
    vettedVersion: "0.3.0",
    sourceUrl:
      "https://github.com/activepieces/activepieces/tree/main/packages/pieces/community/claude",
    licenseSpdx: "MIT",
    estimatedSizeMb: 50,
  },
];

/** Look up a catalog entry by Jarvis-side id. Returns null when missing. */
export function findCatalogEntry(id: string): CatalogEntry | null {
  return CATALOG.find((entry) => entry.id === id) ?? null;
}

/**
 * Stable map keyed by id, useful in callers that look up entries repeatedly
 * (the API route handlers, the reconciler). Re-computed every call -- the
 * catalog is tiny and never mutates at runtime.
 */
export function catalogById(): Map<string, CatalogEntry> {
  return new Map(CATALOG.map((entry) => [entry.id, entry]));
}
