/**
 * Hook for the Connections panel: fetches `/api/workflows/connections`,
 * exposes the list + registered Jarvis sources, and offers add/delete
 * mutations. Connection `value` is never returned by the API (encrypted at
 * rest server-side), so this layer only models the metadata.
 */

import { useCallback, useEffect, useState } from "react";

export type AppConnectionType =
  | "OAUTH2"
  | "PLATFORM_OAUTH2"
  | "CLOUD_OAUTH2"
  | "SECRET_TEXT"
  | "BASIC_AUTH"
  | "CUSTOM_AUTH"
  | "NO_AUTH";

export interface ConnectionMeta {
  id: string;
  externalId: string;
  displayName: string;
  type: AppConnectionType;
  scope: "PROJECT" | "PLATFORM";
  status: "ACTIVE" | "MISSING" | "ERROR";
  pieceName: string;
  pieceVersion: string;
  ownerId: string | null;
  preSelectForNewProjects: boolean;
  created: number;
  updated: number;
}

export interface JarvisSourceMeta {
  /** Source id, e.g. "google". External ids it claims look like `jarvis:<id>` or `jarvis:<id>:*`. */
  id: string;
}

export interface ConnectionsState {
  loading: boolean;
  error: string | null;
  connections: ConnectionMeta[];
  jarvisSources: JarvisSourceMeta[];
  refresh: () => Promise<void>;
  create: (input: {
    externalId: string;
    displayName: string;
    type: AppConnectionType;
    pieceName: string;
    pieceVersion?: string;
    value: Record<string, unknown>;
  }) => Promise<{ ok: boolean; message: string }>;
  remove: (id: string) => Promise<{ ok: boolean; message: string }>;
}

export function useConnections(): ConnectionsState {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionMeta[]>([]);
  const [jarvisSources, setJarvisSources] = useState<JarvisSourceMeta[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/workflows/connections");
      if (!r.ok) {
        setError(`fetch failed: ${r.status}`);
        return;
      }
      const body = (await r.json()) as {
        connections: ConnectionMeta[];
        jarvisSources: JarvisSourceMeta[];
      };
      setConnections(body.connections);
      setJarvisSources(body.jarvisSources);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create: ConnectionsState["create"] = useCallback(
    async (input) => {
      try {
        const r = await fetch("/api/workflows/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          return { ok: false, message: body.error ?? `HTTP ${r.status}` };
        }
        await refresh();
        return { ok: true, message: "created" };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    [refresh],
  );

  const remove: ConnectionsState["remove"] = useCallback(
    async (id) => {
      try {
        const r = await fetch(`/api/workflows/connections/${id}`, {
          method: "DELETE",
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          return { ok: false, message: body.error ?? `HTTP ${r.status}` };
        }
        await refresh();
        return { ok: true, message: "deleted" };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    },
    [refresh],
  );

  return { loading, error, connections, jarvisSources, refresh, create, remove };
}
