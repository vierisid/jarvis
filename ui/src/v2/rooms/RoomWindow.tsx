import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RoomKey } from "../router";
import { getRoomBody } from "./RoomBodyRegistry";
import { defaultFloatingRect, type LayoutRect } from "./useRoomLayout";
import "./RoomWindow.css";

const ROOM_TITLE: Record<RoomKey, string> = {
  workflows: "Workflows",
  memory: "Memory",
  tools: "Tools",
  agents: "Agents",
  authority: "Authority",
  logs: "Logs",
  calendar: "Calendar",
  goals: "Goals",
  tasks: "Tasks",
  content: "Content",
  workspaces: "Workspaces",
  usage: "Usage",
  settings: "Settings",
};

export interface RoomWindowProps {
  roomKey: RoomKey;
  state: "inline" | "minimized";
  /**
   * Layout placement. `inline` flows in the thread; `floating` positions
   * absolutely with the given rect — only honored when the parent renders
   * the window in the floating layer (above ~900px viewport).
   */
  layout: { mode: "inline" } | { mode: "floating"; rect: LayoutRect };
  onClose: () => void;
  onMinimize: () => void;
  onExpand: () => void;
  onRestore: () => void;
  /**
   * Phase 6.1.6 — called when the user drags the chrome past the detach
   * threshold OR resizes a floating window. Caller persists the rect to
   * per-room layout storage.
   */
  onLayoutChange: (
    next: { mode: "inline" } | { mode: "floating"; rect: LayoutRect },
  ) => void;
  /** Bring this window to the top of the floating stack. */
  onFocus?: () => void;
  /** True when this window is the top-most floating one. */
  focused?: boolean;
}

/**
 * Phase 6.1.5 / 6.1.6 — Room presented as a browser-window-style card.
 *
 * Inline mode renders in the thread flow with full card width; floating
 * mode renders absolutely positioned with the saved rect. Drag the chrome
 * to move/detach; drag the bottom-right corner to resize. Pastel mac-style
 * traffic lights handle close/minimize/expand.
 */
export function RoomWindow({
  roomKey,
  state,
  layout,
  onClose,
  onMinimize,
  onExpand,
  onRestore,
  onLayoutChange,
  onFocus,
  focused,
}: RoomWindowProps) {
  const Body = getRoomBody(roomKey);
  const minimized = state === "minimized";
  const title = ROOM_TITLE[roomKey];
  const rootRef = useRef<HTMLDivElement | null>(null);

  // ── Drag (move) ─────────────────────────────────────────────────────
  // Tracking ref instead of state so pointermove events don't thrash React.
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origRect: LayoutRect;
    detached: boolean; // true once movement crossed the detach threshold
  } | null>(null);

  const onChromePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // Ignore clicks on traffic lights themselves.
      const target = e.target as HTMLElement;
      if (target.closest(".v2-roomwin__light")) return;
      // Only primary button.
      if (e.button !== 0) return;

      const rect = layout.mode === "floating"
        ? layout.rect
        : (() => {
            // Capture current geometry for an inline window so detachment
            // begins where it visually was.
            const el = rootRef.current;
            if (!el) return defaultFloatingRect();
            const box = el.getBoundingClientRect();
            return { x: box.left, y: box.top, w: box.width, h: box.height };
          })();

      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origRect: rect,
        detached: layout.mode === "floating",
      };

      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      onFocus?.();
    },
    [layout, onFocus],
  );

  const onChromePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;

      if (!drag.detached) {
        // Detach inline → floating after 8px of movement. Tight enough that
        // intentional drags trigger but a click-then-release doesn't.
        if (dx * dx + dy * dy < 64) return;
        drag.detached = true;
      }

      const rect = {
        x: drag.origRect.x + dx,
        y: drag.origRect.y + dy,
        w: drag.origRect.w,
        h: drag.origRect.h,
      };
      onLayoutChange({ mode: "floating", rect });
    },
    [onLayoutChange],
  );

  const onChromePointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {/* ignore */}
      dragRef.current = null;
    }
  }, []);

  // ── Resize (bottom-right corner, floating only) ─────────────────────
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; origRect: LayoutRect } | null>(null);

  const onResizePointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (layout.mode !== "floating") return;
      e.stopPropagation();
      if (e.button !== 0) return;
      resizeRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origRect: layout.rect,
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      onFocus?.();
    },
    [layout, onFocus],
  );

  const onResizePointerMove = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      const r = resizeRef.current;
      if (!r || r.pointerId !== e.pointerId) return;
      const dx = e.clientX - r.startX;
      const dy = e.clientY - r.startY;
      const rect = {
        x: r.origRect.x,
        y: r.origRect.y,
        w: Math.max(320, r.origRect.w + dx),
        h: Math.max(200, r.origRect.h + dy),
      };
      onLayoutChange({ mode: "floating", rect });
    },
    [onLayoutChange],
  );

  const onResizePointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (resizeRef.current?.pointerId === e.pointerId) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {/* ignore */}
      resizeRef.current = null;
    }
  }, []);

  // Style/class for floating positioning. When inline, no positioning style
  // is applied — the window flows in the thread.
  const isFloating = layout.mode === "floating";
  const floatingStyle: React.CSSProperties | undefined = isFloating
    ? {
        position: "absolute",
        left: layout.rect.x,
        top: layout.rect.y,
        width: layout.rect.w,
        height: minimized ? undefined : layout.rect.h,
      }
    : undefined;

  return (
    <article
      ref={rootRef}
      className={[
        "v2-roomwin",
        minimized ? "v2-roomwin--minimized" : "",
        isFloating ? "v2-roomwin--floating" : "",
        focused ? "v2-roomwin--focused" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={floatingStyle}
      aria-label={`${title} room window`}
      onPointerDownCapture={() => isFloating && onFocus?.()}
    >
      <header
        className="v2-roomwin__chrome"
        onDoubleClick={minimized ? onRestore : onMinimize}
        onPointerDown={onChromePointerDown}
        onPointerMove={onChromePointerMove}
        onPointerUp={onChromePointerUp}
        onPointerCancel={onChromePointerUp}
        // Crosshair cursor while floating, grab cursor while inline (drag-to-detach hint)
        style={{ cursor: isFloating ? "move" : "grab" }}
      >
        <div className="v2-roomwin__lights" role="group" aria-label="Window controls">
          <button
            type="button"
            className="v2-roomwin__light v2-roomwin__light--close"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            aria-label="Close room window"
            title="Close"
          />
          <button
            type="button"
            className="v2-roomwin__light v2-roomwin__light--minimize"
            onClick={(e) => { e.stopPropagation(); minimized ? onRestore() : onMinimize(); }}
            aria-label={minimized ? "Restore room window" : "Minimize room window"}
            title={minimized ? "Restore" : "Minimize"}
          />
          <button
            type="button"
            className="v2-roomwin__light v2-roomwin__light--expand"
            onClick={(e) => { e.stopPropagation(); onExpand(); }}
            aria-label="Expand room to fullscreen"
            title="Expand"
          />
        </div>

        <div className="v2-roomwin__title">{title}</div>

        <div className="v2-roomwin__meta" aria-hidden="true">
          {roomKey}
        </div>
      </header>

      {!minimized && (
        <div className="v2-roomwin__body">
          <Body mode="inline" />
        </div>
      )}

      {/* Resize handle — floating non-minimized only */}
      {isFloating && !minimized && (
        <div
          className="v2-roomwin__resize"
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          onPointerCancel={onResizePointerUp}
          aria-hidden="true"
        />
      )}
    </article>
  );
}
