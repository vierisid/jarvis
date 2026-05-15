/**
 * Hook for the Library tab. Fetches the catalog (curated community pieces
 * Jarvis users can install), tracks per-piece "installing" / "uninstalling"
 * state, exposes install + uninstall mutations.
 *
 * Secrets stay server-side; this layer only models metadata + transitions.
 */

import { useCallback, useEffect, useState } from "react";

export type PieceTier = "verified" | "community";

export interface LibraryEntry {
  id: string;
  npmPackage: string;
  versionRange: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  vettedVersion: string;
  /** ISO date when a human last vetted this piece. Null on community pieces. */
  vettedAt: string | null;
  sourceUrl: string;
  licenseSpdx: string;
  /** Disk footprint after install, in MB. Null when not measured. */
  estimatedSizeMb: number | null;
  /**
   * Trust tier:
   *   "verified"  -- hand-reviewed + smoke-tested by a Jarvis maintainer.
   *   "community" -- pulled from npm under the @activepieces/piece-* prefix
   *                  but not individually reviewed. Runs in the engine
   *                  sandbox; user opts in with explicit eyes.
   */
  tier: PieceTier;
  installed: {
    resolvedVersion: string;
    installedAt: number;
  } | null;
}

export type LibraryActionState = "idle" | "installing" | "uninstalling";

export interface LibraryState {
  loading: boolean;
  error: string | null;
  entries: LibraryEntry[];
  /** Per-entry transition state, keyed by piece id. */
  actionState: Record<string, LibraryActionState>;
  refresh: () => Promise<void>;
  install: (id: string) => Promise<{ ok: boolean; message: string; partial?: boolean }>;
  uninstall: (id: string) => Promise<{ ok: boolean; message: string }>;
}

export function useLibrary(): LibraryState {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [actionState, setActionState] = useState<Record<string, LibraryActionState>>({});

  const setOne = useCallback((id: string, state: LibraryActionState) => {
    setActionState((prev) => ({ ...prev, [id]: state }));
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/workflows/pieces/library");
      if (!r.ok) {
        setError(`fetch failed: ${r.status}`);
        return;
      }
      const body = (await r.json()) as { entries: LibraryEntry[] };
      setEntries(body.entries);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const install: LibraryState["install"] = useCallback(
    async (id) => {
      setOne(id, "installing");
      try {
        const r = await fetch(`/api/workflows/pieces/library/${id}/install`, {
          method: "POST",
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          return { ok: false, message: body.error ?? `HTTP ${r.status}` };
        }
        const body = (await r.json().catch(() => ({}))) as {
          installed?: boolean;
          catalogRefreshFailed?: boolean;
          catalogRefreshError?: string;
        };
        await refresh();
        if (body.catalogRefreshFailed) {
          return {
            ok: true,
            partial: true,
            message: `installed; piece won't show in the editor until daemon restarts (${body.catalogRefreshError ?? "metadata extract failed"})`,
          };
        }
        return { ok: true, message: "installed" };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      } finally {
        setOne(id, "idle");
      }
    },
    [refresh, setOne],
  );

  const uninstall: LibraryState["uninstall"] = useCallback(
    async (id) => {
      setOne(id, "uninstalling");
      try {
        const r = await fetch(`/api/workflows/pieces/library/${id}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          return { ok: false, message: body.error ?? `HTTP ${r.status}` };
        }
        await refresh();
        return { ok: true, message: "uninstalled" };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      } finally {
        setOne(id, "idle");
      }
    },
    [refresh, setOne],
  );

  return { loading, error, entries, actionState, refresh, install, uninstall };
}
