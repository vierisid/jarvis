import { useCallback, useEffect, useState } from "react";
import type { RoomKey } from "../router";

/**
 * Per-room layout persistence (Phase 6.1.6).
 *
 * Stores each Room's preferred layout in localStorage so that opening Tools
 * a second time restores its floating position from the previous session.
 * Inline is the default; floating is opt-in via drag-to-detach.
 *
 * Layouts are stored independently of the live `room-window` ThreadItem
 * state — the items array reflects what's currently open; this hook
 * remembers preferences across opens and reloads.
 */

export type LayoutRect = { x: number; y: number; w: number; h: number };

export type RoomLayout =
  | { mode: "inline" }
  | { mode: "floating"; rect: LayoutRect };

const STORAGE_KEY = "jarvis:room-layout";

export const DEFAULT_LAYOUT: RoomLayout = { mode: "inline" };

/**
 * Default rect for a newly-floated window. Centered-ish on the viewport,
 * sized for comfortable browsing. Used when the user detaches a window
 * for the first time and there's no saved rect.
 */
export function defaultFloatingRect(): LayoutRect {
  if (typeof window === "undefined") {
    return { x: 80, y: 80, w: 520, h: 420 };
  }
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const w = Math.min(560, Math.max(360, Math.round(vw * 0.42)));
  const h = Math.min(560, Math.max(320, Math.round(vh * 0.55)));
  // Stagger origin off the top-left so successive detaches don't perfectly
  // overlap. Caller can offset further if needed.
  return { x: 80, y: 80, w, h };
}

/**
 * Clamp a saved rect to the current viewport. If the window would be more
 * than half off-screen (e.g. viewport shrunk since save), reset to the
 * default position. Caller passes the result back into setLayout when
 * loading.
 */
export function clampRect(rect: LayoutRect): LayoutRect {
  if (typeof window === "undefined") return rect;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;

  const w = Math.min(rect.w, Math.max(280, vw - 40));
  const h = Math.min(rect.h, Math.max(220, vh - 80));

  let x = Math.max(0, Math.min(rect.x, vw - 80)); // keep at least 80px on screen
  let y = Math.max(0, Math.min(rect.y, vh - 60));

  // If half off-screen → reset
  if (x + w / 2 < 0 || x > vw - 40 || y + h / 2 < 0 || y > vh - 40) {
    return defaultFloatingRect();
  }
  return { x, y, w, h };
}

type LayoutMap = Partial<Record<RoomKey, RoomLayout>>;

function loadAll(): LayoutMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as LayoutMap;
  } catch {
    return {};
  }
}

function saveAll(map: LayoutMap): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
}

export function useRoomLayout() {
  const [layouts, setLayouts] = useState<LayoutMap>(loadAll);

  // Cross-tab sync — if the user changes layout in another tab, pick it up.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setLayouts(loadAll());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const getLayout = useCallback(
    (key: RoomKey): RoomLayout => {
      const stored = layouts[key];
      if (!stored) return DEFAULT_LAYOUT;
      if (stored.mode === "floating") {
        return { mode: "floating", rect: clampRect(stored.rect) };
      }
      return stored;
    },
    [layouts],
  );

  const setLayout = useCallback((key: RoomKey, layout: RoomLayout) => {
    setLayouts((prev) => {
      const next = { ...prev, [key]: layout };
      saveAll(next);
      return next;
    });
  }, []);

  /** Reset every saved layout to inline. Used by the voice "reorder" command. */
  const resetAllLayouts = useCallback(() => {
    setLayouts(() => {
      const next: LayoutMap = {};
      saveAll(next);
      return next;
    });
  }, []);

  return { getLayout, setLayout, resetAllLayouts, layouts };
}
