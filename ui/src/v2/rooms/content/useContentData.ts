import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveData } from "../../shell/LiveDataContext";

const POLL_INTERVAL_MS = 8000;

export type ContentStage =
  | "idea"
  | "research"
  | "outline"
  | "draft"
  | "assets"
  | "review"
  | "scheduled"
  | "published";

export type ContentType =
  | "youtube"
  | "blog"
  | "twitter"
  | "instagram"
  | "tiktok"
  | "linkedin"
  | "podcast"
  | "newsletter"
  | "short_form"
  | "other";

export const CONTENT_STAGES: ReadonlyArray<ContentStage> = [
  "idea", "research", "outline", "draft", "assets", "review", "scheduled", "published",
];

export const CONTENT_TYPES: ReadonlyArray<ContentType> = [
  "youtube", "blog", "twitter", "instagram", "tiktok", "linkedin",
  "podcast", "newsletter", "short_form", "other",
];

export interface ContentItem {
  id: string;
  title: string;
  body: string;
  content_type: ContentType;
  stage: ContentStage;
  tags: string[];
  scheduled_at: number | null;
  published_at: number | null;
  published_url: string | null;
  created_by: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface ContentStageNote {
  id: string;
  content_id: string;
  stage: ContentStage;
  note: string;
  author: string | null;
  created_at: number;
}

export interface ContentAttachment {
  id: string;
  content_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  label: string | null;
  created_at: number;
}

interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Content Pipeline Room hook — loads /api/content, subscribes to
 * `contentEvents` from LiveDataContext for instant updates, exposes
 * write actions for the full CRUD + advance/regress + schedule flows.
 * Reuses 13 existing endpoints; no new backend.
 */
export function useContentData() {
  const live = useLiveData();
  const [items, setItems] = useState<ContentItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlightRef = useRef(false);
  const lastEventCountRef = useRef(0);

  const refresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const resp = await fetch("/api/content");
      if (resp.ok) {
        const data = (await resp.json()) as ContentItem[];
        setItems(Array.isArray(data) ? data : []);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load content");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = window.setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Live tail — refresh on any new content event.
  useEffect(() => {
    if (live.contentEvents.length !== lastEventCountRef.current) {
      lastEventCountRef.current = live.contentEvents.length;
      refresh();
    }
  }, [live.contentEvents.length, refresh]);

  const itemsByStage = useMemo(() => {
    const map = new Map<ContentStage, ContentItem[]>();
    for (const s of CONTENT_STAGES) map.set(s, []);
    for (const it of items) map.get(it.stage)?.push(it);
    for (const arr of map.values()) {
      arr.sort((a, b) => a.sort_order - b.sort_order);
    }
    return map;
  }, [items]);

  const stats = useMemo(() => {
    const inFlightStages: ReadonlySet<ContentStage> = new Set([
      "idea", "research", "outline", "draft", "assets", "review",
    ]);
    return {
      total: items.length,
      inFlight: items.filter((i) => inFlightStages.has(i.stage)).length,
      scheduled: items.filter((i) => i.stage === "scheduled").length,
      published: items.filter((i) => i.stage === "published").length,
    };
  }, [items]);

  const findByName = useCallback(
    (name: string): ContentItem | null => {
      const q = name.trim().toLowerCase();
      if (!q) return null;
      const exact = items.find((i) => i.title.toLowerCase() === q);
      if (exact) return exact;
      return items.find((i) => i.title.toLowerCase().includes(q)) ?? null;
    },
    [items],
  );

  const createContent = useCallback(
    async (input: {
      title: string;
      content_type?: ContentType;
      stage?: ContentStage;
      tags?: string[];
      body?: string;
    }): Promise<{ ok: true; item: ContentItem } | { ok: false; message: string }> => {
      try {
        const resp = await fetch("/api/content", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: input.title,
            content_type: input.content_type ?? "blog",
            stage: input.stage ?? "idea",
            tags: input.tags ?? [],
            body: input.body ?? "",
            created_by: "dashboard",
          }),
        });
        if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
        const item = (await resp.json()) as ContentItem;
        refresh();
        return { ok: true, item };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const updateContent = useCallback(
    async (id: string, patch: Partial<ContentItem>): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/content/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        refresh();
        return { ok: true, message: "Saved." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [refresh],
  );

  const advance = useCallback(async (id: string): Promise<ActionResult> => {
    try {
      const resp = await fetch(`/api/content/${encodeURIComponent(id)}/advance`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
      const item = (await resp.json()) as ContentItem;
      refresh();
      return { ok: true, message: `Advanced to ${item.stage}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  const regress = useCallback(async (id: string): Promise<ActionResult> => {
    try {
      const resp = await fetch(`/api/content/${encodeURIComponent(id)}/regress`, {
        method: "POST",
      });
      if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
      const item = (await resp.json()) as ContentItem;
      refresh();
      return { ok: true, message: `Moved back to ${item.stage}.` };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  const schedule = useCallback(
    async (id: string, scheduled_at: number): Promise<ActionResult> => {
      const r = await updateContent(id, {
        scheduled_at,
        stage: "scheduled" as ContentStage,
      });
      if (!r.ok) return r;
      return { ok: true, message: `Scheduled for ${formatDateTime(scheduled_at)}.` };
    },
    [updateContent],
  );

  const deleteContent = useCallback(async (id: string): Promise<ActionResult> => {
    try {
      const resp = await fetch(`/api/content/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      refresh();
      return { ok: true, message: "Deleted." };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Failed" };
    }
  }, [refresh]);

  const listNotes = useCallback(
    async (id: string): Promise<ContentStageNote[]> => {
      try {
        const resp = await fetch(`/api/content/${encodeURIComponent(id)}/notes`);
        if (!resp.ok) return [];
        return (await resp.json()) as ContentStageNote[];
      } catch {
        return [];
      }
    },
    [],
  );

  const addNote = useCallback(
    async (id: string, stage: ContentStage, note: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(`/api/content/${encodeURIComponent(id)}/notes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage, note, author: "dashboard" }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, message: "Note added." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [],
  );

  const listAttachments = useCallback(
    async (id: string): Promise<ContentAttachment[]> => {
      try {
        const resp = await fetch(`/api/content/${encodeURIComponent(id)}/attachments`);
        if (!resp.ok) return [];
        return (await resp.json()) as ContentAttachment[];
      } catch {
        return [];
      }
    },
    [],
  );

  const addAttachment = useCallback(
    async (id: string, file: File, label?: string): Promise<ActionResult> => {
      try {
        const fd = new FormData();
        fd.append("file", file);
        if (label) fd.append("label", label);
        const resp = await fetch(`/api/content/${encodeURIComponent(id)}/attachments`, {
          method: "POST",
          body: fd,
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, message: `Uploaded ${file.name}.` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [],
  );

  const deleteAttachment = useCallback(
    async (contentId: string, attachmentId: string): Promise<ActionResult> => {
      try {
        const resp = await fetch(
          `/api/content/${encodeURIComponent(contentId)}/attachments/${encodeURIComponent(attachmentId)}`,
          { method: "DELETE" },
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return { ok: true, message: "Removed." };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : "Failed" };
      }
    },
    [],
  );

  return {
    items,
    itemsByStage,
    stats,
    loading,
    error,
    refresh,
    findByName,
    createContent,
    updateContent,
    advance,
    regress,
    schedule,
    deleteContent,
    listNotes,
    addNote,
    listAttachments,
    addAttachment,
    deleteAttachment,
  };
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
