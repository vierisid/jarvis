import React, { useCallback, useEffect } from "react";
import { CommandPalette } from "../palette/CommandPalette";
import type { PaletteResult, PaletteNavEntry } from "../palette/types";

/**
 * W4 — Cmd+K / Ctrl+K palette page.
 *
 * Mounted at `#/_palette` when the daemon spawns the palette panel
 * (sidecar's Ctrl+K hotkey → `pebble.palette` event → `panel.spawn` of
 * a small cursor-anchored window). The page reuses the existing
 * `CommandPalette` component but skips its modal scrim — the panel
 * window itself is the modal, so we paint the palette card edge-to-edge
 * inside the panel's bounds.
 *
 * Picks (`onPickRoom`, `onPickObject`) and close (`onClose`) all POST
 * back to the daemon's `/api/palette/*` endpoints. The daemon-side
 * palette controller handles the actual room spawn + palette dismiss
 * via the same panel-tracking machinery used by voice commands.
 */
export function PalettePage(): React.ReactElement {
  const close = useCallback(() => {
    void fetch("/api/palette/close", { method: "POST" }).catch(() => {
      // Best-effort — even if the close call fails the user can hit
      // the close on the panel chrome.
    });
  }, []);

  const pickRoom = useCallback(
    (entry: PaletteNavEntry, openInRoom: boolean) => {
      void fetch("/api/palette/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "room", key: entry.key, openInRoom }),
      }).catch(() => {
        // If the pick fails, fall back to closing the palette so the
        // user isn't stuck looking at a frozen window.
        close();
      });
    },
    [close],
  );

  const pickObject = useCallback(
    (result: PaletteResult, _openInRoom: boolean) => {
      // Object → route to the owning Room. The panel-mode palette
      // doesn't have a thread to inject an InlineCard into, so the
      // simplest useful behaviour is to open the matching Room as a
      // panel.
      const TYPE_TO_ROOM: Record<PaletteResult["type"], string> = {
        workflow: "workflows",
        memory: "memory",
        tool: "tools",
        agent: "agents",
        authority: "authority",
        log: "logs",
      };
      const key = TYPE_TO_ROOM[result.type];
      if (!key) {
        close();
        return;
      }
      void fetch("/api/palette/pick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "room", key, openInRoom: true }),
      }).catch(() => close());
    },
    [close],
  );

  // Esc → close. The CommandPalette's own Esc handler also calls
  // onClose, but that's only active while it has focus; this top-level
  // listener catches Esc presses that hit the panel before the input
  // mounts.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [close]);

  return (
    <div className="v2-palette-page">
      <CommandPalette
        open
        enabled
        onClose={close}
        onPickObject={pickObject}
        onPickRoom={pickRoom}
      />
    </div>
  );
}
