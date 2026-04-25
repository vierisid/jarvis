import { useCallback, useEffect, useState } from "react";
import type { PaletteResult } from "./types";

const STORAGE_KEY = "jarvis:palette-recent";
const MAX = 5;

/**
 * Recent palette picks, daemon-backed when reachable, localStorage-backed
 * otherwise. Daemon is the source of truth (cross-device, survives reload);
 * localStorage caches the last server response so the palette has something
 * useful even when the daemon is offline.
 *
 * Options:
 *  - `enabled` (default true) — whether to hit the daemon. False short-circuits
 *    to localStorage only (e.g. in mock mode where there's no daemon at all).
 */
export function usePaletteRecent(opts: { enabled?: boolean } = {}) {
  const enabled = opts.enabled !== false;
  const [recent, setRecent] = useState<PaletteResult[]>(() => loadFromStorage());

  // Refresh from daemon whenever this hook mounts in an enabled context
  // (the palette opens/closes the consumer; mounting on each open is fine).
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch(`/api/palette/recent?limit=${MAX}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const rows = Array.isArray((data as { recent?: unknown[] }).recent)
          ? ((data as { recent: unknown[] }).recent as unknown[])
          : [];
        const normalized = rows
          .map(toResult)
          .filter((x): x is PaletteResult => x !== null)
          .slice(0, MAX);
        if (normalized.length > 0) {
          setRecent(normalized);
          saveToStorage(normalized);
        }
      })
      .catch(() => {
        // swallow — localStorage already loaded
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const remember = useCallback(
    (item: PaletteResult) => {
      // Optimistic update so the palette feels instant on the next open.
      setRecent((prev) => {
        const dedup = prev.filter((p) => !(p.type === item.type && p.id === item.id));
        const next = [item, ...dedup].slice(0, MAX);
        saveToStorage(next);
        return next;
      });
      if (enabled) {
        fetch("/api/palette/recent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: item.type,
            id: item.id,
            title: item.title,
            summary: item.summary,
            meta: item.meta,
          }),
        }).catch(() => {/* offline? localStorage covers us */});
      }
    },
    [enabled],
  );

  const clear = useCallback(() => {
    setRecent([]);
    saveToStorage([]);
  }, []);

  return { recent, remember, clear };
}

function loadFromStorage(): PaletteResult[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(toResult)
      .filter((x): x is PaletteResult => x !== null);
  } catch {
    return [];
  }
}

function saveToStorage(items: PaletteResult[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // quota / private mode — ignore
  }
}

function toResult(x: unknown): PaletteResult | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.type !== "string" || typeof o.title !== "string") {
    return null;
  }
  return {
    type: o.type as PaletteResult["type"],
    id: o.id,
    ref: typeof o.ref === "string" ? o.ref : o.id,
    title: o.title,
    summary: typeof o.summary === "string" ? o.summary : undefined,
    meta: typeof o.meta === "string" ? o.meta : undefined,
    status: undefined,
  };
}
