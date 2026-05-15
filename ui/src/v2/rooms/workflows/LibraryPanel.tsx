/**
 * Library panel: tiered list of activepieces community pieces a Jarvis user
 * can opt into installing. Rendered as two sections:
 *
 *   - Verified  -- hand-reviewed by a maintainer, no preamble needed.
 *   - Community -- pulled from npm; runs in the engine sandbox but has not
 *                  been individually reviewed. Collapsed by default behind
 *                  a one-line "third-party code" notice so users opt in
 *                  with their eyes open.
 *
 * Each row shows piece metadata, vetted version, license, source link, and
 * an Install / Uninstall button. Search filters across both tiers.
 *
 * Pieces install via npm at runtime into `~/.jarvis/pieces/`; this panel
 * only triggers the install/uninstall + reflects state, it doesn't bundle
 * any piece code itself.
 */

import React, { useMemo, useState } from "react";
import { Button, Chip, Icon } from "../../ui";
import { ChevronRight, RefreshCw, Download, Trash2, ExternalLink, ShieldCheck } from "lucide-react";
import { useLibrary, type LibraryEntry, type LibraryActionState } from "./useLibrary";

export function LibraryPanel(): React.ReactElement {
  const lib = useLibrary();
  const [toast, setToast] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [communityOpen, setCommunityOpen] = useState(false);

  const flash = (tone: "ok" | "warn", text: string): void => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 4000);
  };

  const installedCount = lib.entries.filter((e) => e.installed !== null).length;

  // Filtered + tier-split view. Search is case-insensitive against
  // displayName + npmPackage + description so users typing "gmail" find
  // gmail regardless of which field carries the match.
  const { verified, community } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (e: LibraryEntry): boolean =>
      !q ||
      e.displayName.toLowerCase().includes(q) ||
      e.npmPackage.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.id.includes(q);
    const verified: LibraryEntry[] = [];
    const community: LibraryEntry[] = [];
    for (const e of lib.entries) {
      if (!matches(e)) continue;
      if (e.tier === "verified") verified.push(e);
      else community.push(e);
    }
    return { verified, community };
  }, [lib.entries, query]);

  // Auto-expand the community list when the user is actively searching so
  // their typed query isn't hidden behind the collapsed disclosure.
  const showCommunity = communityOpen || query.trim().length > 0;

  return (
    <div className="wf-lib">
      <header className="wf-lib__header">
        <div>
          <h3 className="wf-lib__title">Pieces library</h3>
          <p className="wf-lib__subtitle">
            {lib.loading
              ? "loading..."
              : `${installedCount} installed of ${lib.entries.length} available`}
            {lib.error ? ` - ${lib.error}` : null}
          </p>
        </div>
        <div className="wf-lib__actions">
          <Button variant="ghost" size="sm" onClick={() => void lib.refresh()} title="Refresh">
            <Icon icon={RefreshCw} size={14} /> Refresh
          </Button>
        </div>
      </header>

      <input
        className="wf-lib__search"
        type="search"
        placeholder="Search pieces by name, package, or description"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search pieces"
      />

      {toast ? <div className={`wf-toast wf-toast--${toast.tone}`}>{toast.text}</div> : null}

      {lib.entries.length === 0 && !lib.loading ? (
        <div className="wf-lib__empty">The catalog is empty.</div>
      ) : (
        <>
          {/* Verified section -- always visible, no warning preamble. */}
          <section className="wf-lib__section">
            <h4 className="wf-lib__section-title">
              <Icon icon={ShieldCheck} size={14} /> Verified
              <span className="wf-lib__section-count">{verified.length}</span>
            </h4>
            <p className="wf-lib__section-hint">
              Hand-reviewed by Jarvis maintainers and smoke-tested against the engine.
            </p>
            {verified.length === 0 ? (
              <div className="wf-lib__empty-section">
                {query ? "No verified pieces match the search." : "No verified pieces."}
              </div>
            ) : (
              <ul className="wf-lib__list">
                {verified.map((entry) => (
                  <LibraryRowWired
                    key={entry.id}
                    entry={entry}
                    actionState={lib.actionState[entry.id] ?? "idle"}
                    lib={lib}
                    flash={flash}
                  />
                ))}
              </ul>
            )}
          </section>

          {/* Community section -- collapsed by default, with preamble. */}
          <section className="wf-lib__section">
            <button
              type="button"
              className="wf-lib__section-toggle"
              onClick={() => setCommunityOpen((v) => !v)}
              aria-expanded={showCommunity}
            >
              <Icon
                icon={ChevronRight}
                size={14}
                style={{
                  transform: showCommunity ? "rotate(90deg)" : "rotate(0deg)",
                  transition: "transform var(--dur-fast) var(--ease-out)",
                }}
              />
              Community
              <span className="wf-lib__section-count">{community.length}</span>
            </button>
            {showCommunity ? (
              <>
                <p className="wf-lib__section-hint wf-lib__section-hint--warn">
                  Community pieces are installed from npm and run inside the engine
                  sandbox. They haven't been individually reviewed by Jarvis -- check
                  each piece's source link before opting in.
                </p>
                {community.length === 0 ? (
                  <div className="wf-lib__empty-section">
                    {query ? "No community pieces match the search." : "No community pieces."}
                  </div>
                ) : (
                  <ul className="wf-lib__list">
                    {community.map((entry) => (
                      <LibraryRowWired
                        key={entry.id}
                        entry={entry}
                        actionState={lib.actionState[entry.id] ?? "idle"}
                        lib={lib}
                        flash={flash}
                      />
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Thin wrapper around LibraryRow that wires the install/uninstall handlers.
 * Pulled out so the two tier sections don't duplicate the handler logic.
 */
function LibraryRowWired({
  entry,
  actionState,
  lib,
  flash,
}: {
  entry: LibraryEntry;
  actionState: LibraryActionState;
  lib: ReturnType<typeof useLibrary>;
  flash: (tone: "ok" | "warn", text: string) => void;
}): React.ReactElement {
  return (
    <LibraryRow
      entry={entry}
      actionState={actionState}
      onInstall={async () => {
        if (entry.estimatedSizeMb !== null && entry.estimatedSizeMb >= 100) {
          if (
            !window.confirm(
              `Installing ${entry.displayName} will use about ${entry.estimatedSizeMb}MB of disk. Continue?`,
            )
          ) {
            return;
          }
        }
        const r = await lib.install(entry.id);
        flash(
          r.ok ? (r.partial ? "warn" : "ok") : "warn",
          r.ok ? `${entry.displayName}: ${r.message}` : `Install failed: ${r.message}`,
        );
      }}
      onUninstall={async () => {
        if (
          !window.confirm(
            `Uninstall ${entry.displayName}? Existing workflows that use it will stop working until reinstalled.`,
          )
        )
          return;
        const r = await lib.uninstall(entry.id);
        flash(
          r.ok ? "ok" : "warn",
          r.ok ? `${entry.displayName} uninstalled` : `Uninstall failed: ${r.message}`,
        );
      }}
    />
  );
}

function LibraryRow({
  entry,
  actionState,
  onInstall,
  onUninstall,
}: {
  entry: LibraryEntry;
  actionState: LibraryActionState;
  onInstall: () => void;
  onUninstall: () => void;
}): React.ReactElement {
  const isInstalled = entry.installed !== null;
  const busy = actionState !== "idle";
  // Compare resolved vs vetted to surface the right hint:
  //   resolved < vetted -> "Update available" (we vetted a newer version)
  //   resolved > vetted -> "Newer than vetted" (user upgraded past our audit)
  //   resolved == vetted -> no chip
  const versionRel = isInstalled
    ? compareSemver(entry.installed!.resolvedVersion, entry.vettedVersion)
    : 0;
  const updateAvailable = versionRel < 0;
  const newerThanVetted = versionRel > 0;

  return (
    <li className="wf-lib__row">
      <div className="wf-lib__row-main">
        <div className="wf-lib__row-title">
          <span className="wf-lib__row-name">{entry.displayName}</span>
          {isInstalled ? (
            <Chip tone="ok">Installed {entry.installed!.resolvedVersion}</Chip>
          ) : (
            <Chip tone="neutral">{entry.versionRange}</Chip>
          )}
          {updateAvailable ? (
            <Chip
              tone="warn"
              title={`Installed ${entry.installed!.resolvedVersion} -- catalog vetted ${entry.vettedVersion}. Click Install again to upgrade.`}
            >
              {`Update -> ${entry.vettedVersion}`}
            </Chip>
          ) : null}
          {newerThanVetted ? (
            <Chip tone="warn" title={`Tested with ${entry.vettedVersion}; you have a newer version`}>
              ahead of vetted {entry.vettedVersion}
            </Chip>
          ) : null}
          {entry.licenseSpdx ? <Chip tone="neutral">{entry.licenseSpdx}</Chip> : null}
          {entry.estimatedSizeMb !== null ? (
            <Chip tone="neutral" title="Approximate disk footprint after install">
              ~{entry.estimatedSizeMb}MB
            </Chip>
          ) : null}
        </div>
        {entry.description ? (
          <p className="wf-lib__row-desc">{entry.description}</p>
        ) : null}
        <div className="wf-lib__row-meta">
          <code className="wf-lib__row-pkg">{entry.npmPackage}</code>
          <a
            className="wf-lib__row-source"
            href={entry.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon icon={ExternalLink} size={11} /> source
          </a>
          {entry.vettedAt ? <span>vetted {entry.vettedAt}</span> : null}
        </div>
      </div>
      <div className="wf-lib__row-actions">
        {isInstalled ? (
          <>
            {updateAvailable ? (
              <Button variant="primary" size="sm" onClick={onInstall} disabled={busy}>
                <Icon icon={Download} size={12} />{" "}
                {actionState === "installing" ? "Updating..." : "Update"}
              </Button>
            ) : null}
            <Button variant="danger" size="sm" onClick={onUninstall} disabled={busy}>
              <Icon icon={Trash2} size={12} />{" "}
              {actionState === "uninstalling" ? "Uninstalling..." : "Uninstall"}
            </Button>
          </>
        ) : (
          <Button variant="primary" size="sm" onClick={onInstall} disabled={busy}>
            <Icon icon={Download} size={12} />{" "}
            {actionState === "installing" ? "Installing..." : "Install"}
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Loose semver comparison: returns negative if `a < b`, 0 if equal, positive
 * if `a > b`. Stops at the first numeric mismatch; ignores prerelease tags
 * (catalog entries shouldn't carry them).
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map((p) => parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
