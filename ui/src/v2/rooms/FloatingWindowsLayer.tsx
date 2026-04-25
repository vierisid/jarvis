import React, { useEffect, useState } from "react";
import { RoomWindow } from "./RoomWindow";
import type { ThreadItem } from "../thread/types";
import type { LayoutRect } from "./useRoomLayout";
import "./FloatingWindowsLayer.css";

const FLOATING_BREAKPOINT = 900;

export interface FloatingWindowsLayerProps {
  /** Currently open Room windows. Filtered for `layout.mode === "floating"` here. */
  windows: Extract<ThreadItem, { kind: "room-window" }>[];
  onClose: (id: string) => void;
  onMinimize: (id: string) => void;
  onRestore: (id: string) => void;
  onExpand: (id: string) => void;
  onLayoutChange: (
    id: string,
    next: { mode: "inline" } | { mode: "floating"; rect: LayoutRect },
  ) => void;
}

/**
 * Phase 6.1.6 — overlay layer for floating Room windows.
 *
 * Sits over the thread (z 30) but under palette/room-overlay. Listens for
 * viewport resizes; below 900px floating is disabled and this layer
 * renders nothing (the AppShell still renders the same windows inline in
 * the thread, since the items array is shared).
 *
 * Focus tracking: clicking inside a floating window bumps it to the top
 * of the stack via z-index. Tracked locally because focus is a transient
 * UI concern, not state worth persisting.
 */
export function FloatingWindowsLayer({
  windows,
  onClose,
  onMinimize,
  onRestore,
  onExpand,
  onLayoutChange,
}: FloatingWindowsLayerProps) {
  const [floatingEnabled, setFloatingEnabled] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= FLOATING_BREAKPOINT,
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    const onResize = () => {
      setFloatingEnabled(window.innerWidth >= FLOATING_BREAKPOINT);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  if (!floatingEnabled) return null;

  const floatingWindows = windows.filter((w) => w.layout.mode === "floating");
  if (floatingWindows.length === 0) return null;

  return (
    <div className="v2-floating-layer" aria-label="Floating room windows">
      {floatingWindows.map((w) => (
        <RoomWindow
          key={w.id}
          roomKey={w.roomKey}
          state={w.state}
          layout={w.layout}
          onClose={() => onClose(w.id)}
          onMinimize={() => onMinimize(w.id)}
          onRestore={() => onRestore(w.id)}
          onExpand={() => onExpand(w.id)}
          onLayoutChange={(next) => onLayoutChange(w.id, next)}
          onFocus={() => setFocusedId(w.id)}
          focused={focusedId === w.id}
        />
      ))}
    </div>
  );
}

/** Whether the current viewport supports floating windows. Exported so
 *  the Thread can hide drag-to-detach affordances on small screens. */
export function viewportSupportsFloating(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth >= FLOATING_BREAKPOINT;
}
