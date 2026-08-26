/**
 * Hook for the Library tab. Fetches the catalog (curated community pieces
 * Jarvis users can install), tracks per-piece "installing" / "uninstalling"
 * state, exposes install + uninstall mutations.
 *
 * On a MANAGED install (`managed: true` -- a host installed the whole catalog
 * into a shared read-only tree) the server sends a reduced entry: no install
 * state and none of the per-piece detail an install decision needed. The
 * detail fields are therefore OPTIONAL on this type, and consumers must gate
 * on `managed` rather than on a field happening to be present -- the two
 * shapes come from one endpoint and only `managed` says which one arrived.
 *
 * `install` / `uninstall` stay callable in both modes but the managed server
 * refuses them with a 403; no caller should reach them there.
 *
 * Secrets stay server-side; this layer only models metadata + transitions.
 */

import { useCallback, useEffect, useState } from "react";

export type PieceTier = "verified" | "community";

export interface LibraryEntry {
  id: string;
  npmPackage: string;
  displayName: string;
  description: string;
  iconUrl: string | null;
  /**
   * Trust tier:
   *   "verified"  -- hand-reviewed + smoke-tested by a Jarvis maintainer.
   *   "community" -- pulled from npm under the @activepieces/piece-* prefix
   *                  but not individually reviewed. Runs in the engine
   *                  sandbox; user opts in with explicit eyes.
   */
  tier: PieceTier;

  // ---- Self-managed only. Absent on a managed install, where the host
  // decides what is installed and none of this is the user's to act on.

  versionRange?: string;
  vettedVersion?: string;
  /** ISO date when a human last vetted this piece. Null on community pieces. */
  vettedAt?: string | null;
  sourceUrl?: string;
  licenseSpdx?: string;
  /** Disk footprint after install, in MB. Null when not measured. */
  estimatedSizeMb?: number | null;
  installed?: {
    resolvedVersion: string;
    installedAt: number;
    /**
     * Always "user" -- installed into ~/.jarvis/pieces by this user, which
     * is the only way a piece gets installed on an install that reports
     * install state at all. The server once also emitted "shared" for the
     * host's read-only catalog; that mode is now `managed`, which reports no
     * install state whatsoever.
     */
    source: "user";
  } | null;
}

export type LibraryActionState = "idle" | "installing" | "uninstalling";

export interface LibraryState {
  loading: boolean;
  error: string | null;
  /**
   * True when a host owns this install's catalog: every entry is already
   * usable, entries carry no install state or detail, and the install /
   * uninstall mutations are refused server-side.
   *
   * Starts false and only a successful fetch can raise it, so a failed or
   * in-flight probe renders the self-managed view. That is the safe default
   * in exactly one direction: the managed view's extra claim is "everything
   * here already works", and showing it while the truth is unknown would
   * leave a self-hosted user staring at a list of pieces they do not have
   * and no way to install them.
   */
  managed: boolean;
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
  const [managed, setManaged] = useState<boolean>(false);
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
      const body = (await r.json()) as { managed?: boolean; entries: LibraryEntry[] };
      // `managed` and `entries` are set together: they describe one snapshot,
      // and a render that paired the managed flag with self-managed rows (or
      // the reverse) would read every optional field wrong.
      setManaged(body.managed === true);
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

  return { loading, error, managed, entries, actionState, refresh, install, uninstall };
}
