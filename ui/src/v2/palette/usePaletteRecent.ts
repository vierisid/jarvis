import { useCallback, useEffect, useState } from "react";
import type { PaletteResult } from "./types";

const STORAGE_KEY = "jarvis:palette-recent";
const MAX = 5;

/**
 * Tiny localStorage-backed LRU of the last N palette selections. Survives
 * reloads but not multi-device — Phase 5B (optional) introduces a daemon
 * `recent_objects` table if usage warrants it.
 */
export function usePaletteRecent() {
  const [recent, setRecent] = useState<PaletteResult[]>(() => loadInitial());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
    } catch {
      // ignore quota / private-mode failures
    }
  }, [recent]);

  const remember = useCallback((item: PaletteResult) => {
    setRecent((prev) => {
      const dedup = prev.filter((p) => !(p.type === item.type && p.id === item.id));
      return [item, ...dedup].slice(0, MAX);
    });
  }, []);

  const clear = useCallback(() => setRecent([]), []);

  return { recent, remember, clear };
}

function loadInitial(): PaletteResult[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PaletteResult =>
        !!x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string"
        && typeof (x as { type?: unknown }).type === "string",
    );
  } catch {
    return [];
  }
}
