import React, { useCallback, useEffect, useState } from "react";
import { readArray, useRemoteData } from "../hooks/useRemoteData";
import { openRoom } from "../router";
import { useRoomActionDispatcher } from "../rooms/useRoomActionBus";
import { confirmDialog } from "../ui/ConfirmDialog";
import {
  pillView,
  requestSidecarUpdate,
  updateInProgress,
  type SidecarUpdateInfo,
} from "./sidecar-update";

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
  const { dispatch } = useRoomActionDispatcher();
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!note) return;
    const id = window.setTimeout(() => setNote(null), NOTE_MS);
    return () => window.clearTimeout(id);
  }, [note]);

  const view = pillView(data ?? []);

  const onClick = useCallback(async () => {
    if (!view.show || busy) return;
    if (view.target === "settings") {
      openRoom("settings");
      dispatch({ room: "settings", action: "switch_tab", args: { tab: "sidecar" }, ts: Date.now() });
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
    void refresh();
  }, [view, busy, dispatch, refresh]);

  if (!view.show && !note) return null;
  return (
    <>
      {view.show && (
        <button
          type="button"
          className="rs-chip"
          onClick={onClick}
          disabled={busy}
          title={view.title}
          aria-label={`${view.label}: ${view.title}`}
        >
          <span className="rs-dot" />
          {view.label}
        </button>
      )}
      <span className={`rs-chip${note && !note.ok ? " bad" : ""}`} role="status" aria-live="polite" hidden={!note}>
        {note?.text}
      </span>
    </>
  );
}
