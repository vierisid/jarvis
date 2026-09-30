import React, { useEffect, useState } from "react";
import { readArray, useRemoteData } from "../hooks/useRemoteData";
import { openRoom } from "../router";
import { confirmDialog } from "../ui/ConfirmDialog";
import {
  pillView,
  requestSidecarUpdate,
  updateInProgress,
  type SidecarUpdateInfo,
} from "./sidecar-update";
import { SIDECARS_CHANGED_EVENT, announceSidecarsChanged, requestSettingsTab } from "./settings-tab-request";

/**
 * Top-bar hint that a connected sidecar is behind the version this brain
 * ships with. One sidecar with a native prompt: the click opens that prompt on
 * its machine. One without (Linux): confirm here, then install. Anything else
 * goes to Settings > Sidecar. Hidden when nothing is behind.
 */

const POLL_MS = 30_000;
const NOTE_MS = 6_000;
const decode = (v: unknown) => readArray<SidecarUpdateInfo>(v);

export function SidecarUpdatePill() {
  const { data, refresh } = useRemoteData<SidecarUpdateInfo[]>("/api/sidecars", decode, POLL_MS);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(id);
  }, [note]);

  // An update started from Settings changes what this shows; don't wait for
  // the next poll.
  useEffect(() => {
    const onChanged = () => { void refresh(); };
    window.addEventListener(SIDECARS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(SIDECARS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  const view = pillView(data ?? []);

  const onClick = async () => {
    if (!view.show || busy) return;
    if (view.target === "settings") {
      requestSettingsTab("sidecar");
      openRoom("settings");
      return;
    }
    const sc = view.sidecar;
    if (updateInProgress(sc.update_state)) {
      setNote({ text: `Already updating ${sc.hostname ?? sc.name}.`, ok: true });
      return;
    }
    if (view.action === "apply") {
      const ok = await confirmDialog(
        `Update the sidecar on "${sc.name}" to ${sc.latest_version ?? "the latest version"}? It restarts for a few seconds; the brain keeps working.`,
      );
      if (!ok) return;
    }
    setBusy(true);
    const r = await requestSidecarUpdate(sc, view.action);
    setBusy(false);
    setNote({ text: r.message, ok: r.ok });
    announceSidecarsChanged();
  };

  return (
    <>
      {view.show && (
        <button
          type="button"
          className="rs-chip"
          onClick={onClick}
          aria-disabled={busy}
          title={view.title}
          aria-label={`${view.label}: ${view.title}`}
        >
          <span className="rs-dot" />
          {view.label}
        </button>
      )}
      {note && (
        <span className="rs-chip rs-note" title={note.text} aria-hidden="true">
          {note.text}
        </span>
      )}
      {/* Always mounted, so the result is announced reliably. */}
      <span className="v2-sr-only" role="status" aria-live="polite">{note?.text ?? ""}</span>
    </>
  );
}
