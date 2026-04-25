import Fuse from "fuse.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PaletteResult } from "./types";

/**
 * Debounced palette search. Hits `/api/palette/search?q=` (server-side
 * substring match per type, capped per type), then re-ranks client-side
 * with Fuse so close-but-imperfect matches surface first.
 *
 * Returns the LATEST results for the LATEST query — earlier in-flight
 * requests are cancelled via AbortController so a fast typist doesn't
 * see stale results land out of order.
 */
export function usePaletteSearch(query: string, opts: { enabled: boolean }) {
  const [results, setResults] = useState<PaletteResult[]>([]);
  const [loading, setLoading] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!opts.enabled) {
      setResults([]);
      return;
    }
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);

    const t = setTimeout(async () => {
      try {
        const url = `/api/palette/search?q=${encodeURIComponent(query)}&per_type=8`;
        const resp = await fetch(url, { signal: ctrl.signal });
        if (!resp.ok) {
          setResults([]);
          return;
        }
        const data = (await resp.json()) as { results?: PaletteResult[] };
        setResults(Array.isArray(data.results) ? data.results : []);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") {
          console.warn("[palette] search failed:", err);
          setResults([]);
        }
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 150);

    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [query, opts.enabled]);

  const fuse = useMemo(
    () =>
      new Fuse(results, {
        keys: [
          { name: "title", weight: 0.6 },
          { name: "summary", weight: 0.25 },
          { name: "meta", weight: 0.15 },
        ],
        threshold: 0.4,
        ignoreLocation: true,
        minMatchCharLength: 2,
      }),
    [results],
  );

  const ranked = useMemo(() => {
    const q = query.trim();
    if (!q) return results;
    const matches = fuse.search(q);
    if (matches.length === 0) return results;
    return matches.map((m) => m.item);
  }, [fuse, query, results]);

  return { results: ranked, loading };
}
