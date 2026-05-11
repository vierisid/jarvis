/**
 * Library panel: curated list of activepieces community pieces a Jarvis
 * user can opt into installing. Each row shows piece metadata, vetted
 * version, license, source link, and an Install / Uninstall button.
 *
 * Pieces install via npm at runtime into `~/.jarvis/pieces/`; this panel
 * only triggers the install/uninstall + reflects state, it doesn't bundle
 * any piece code itself.
 */

import React, { useState } from "react";
import { Button, Chip, Icon } from "../../ui";
import { RefreshCw, Download, Trash2, ExternalLink } from "lucide-react";
import { useLibrary, type LibraryEntry, type LibraryActionState } from "./useLibrary";

export function LibraryPanel(): React.ReactElement {
  const lib = useLibrary();
  const [toast, setToast] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const flash = (tone: "ok" | "warn", text: string): void => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 4000);
  };

  const installedCount = lib.entries.filter((e) => e.installed !== null).length;

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

      <p className="wf-lib__intro">
        Curated activepieces community pieces. Installing fetches the package from
        npm into <code>~/.jarvis/pieces/</code>. Each piece runs with full daemon
        access -- only install pieces you trust. See each entry's source link
        before opting in.
      </p>

      {toast ? <div className={`wf-toast wf-toast--${toast.tone}`}>{toast.text}</div> : null}

      {lib.entries.length === 0 && !lib.loading ? (
        <div className="wf-lib__empty">The catalog is empty.</div>
      ) : (
        <ul className="wf-lib__list">
          {lib.entries.map((entry) => (
            <LibraryRow
              key={entry.id}
              entry={entry}
              actionState={lib.actionState[entry.id] ?? "idle"}
              onInstall={async () => {
                if (entry.estimatedSizeMb !== null && entry.estimatedSizeMb >= 100) {
                  // Disk-footprint warning for heavyweight pieces (gmail
                  // pulls 165MB through googleapis). Mid-weight pieces
                  // skip the prompt; the badge in the row already surfaces
                  // the number.
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
          ))}
        </ul>
      )}
    </div>
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
  const vettedMismatch =
    isInstalled && entry.installed!.resolvedVersion !== entry.vettedVersion;

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
          {vettedMismatch ? (
            <Chip tone="warn" title={`Tested with ${entry.vettedVersion}`}>
              vetted {entry.vettedVersion}
            </Chip>
          ) : null}
          <Chip tone="neutral">{entry.licenseSpdx}</Chip>
          {entry.estimatedSizeMb !== null ? (
            <Chip tone="neutral" title="Approximate disk footprint after install">
              ~{entry.estimatedSizeMb}MB
            </Chip>
          ) : null}
        </div>
        <p className="wf-lib__row-desc">{entry.description}</p>
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
          <span>vetted {entry.vettedAt}</span>
        </div>
      </div>
      <div className="wf-lib__row-actions">
        {isInstalled ? (
          <Button variant="danger" size="sm" onClick={onUninstall} disabled={busy}>
            <Icon icon={Trash2} size={12} />{" "}
            {actionState === "uninstalling" ? "Uninstalling..." : "Uninstall"}
          </Button>
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
