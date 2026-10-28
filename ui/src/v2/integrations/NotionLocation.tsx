import React, { useEffect, useState } from "react";
import { useNotionStatus } from "./NotionConnection";
import "./clickup.css";
export function NotionLocation({
  input,
  onChange,
  field = "pageId",
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  field?: "pageId" | "block_id";
}) {
  const status = useNotionStatus();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(false);
  const value = String(input[field] ?? "");
  const [manual, setManual] = useState(!!value);
  useEffect(() => {
    if (!status?.connected || manual) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    setOptions([]);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({
        query,
        generation: status.generation ?? "",
      });
      void fetch("/api/integrations/notion/options?" + params, {
        signal: controller.signal,
      })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error || "Could not load pages.");
          if (active) {
            setOptions(body.options);
            setMore(body.has_more);
          }
        })
        .catch((e) => {
          if (active && e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [status?.connected, status?.generation, query, manual, revision]);
  return (
    <section className="clickup-location" aria-label="Notion page selection">
      <label className="wf-props__field-label">
        <span>
          {field === "block_id" ? "Page or block" : "Page"}{" "}
          <span aria-hidden="true">*</span>
        </span>
        {manual ? (
          <input
            className="wf-props__input"
            value={value}
            onChange={(e) => onChange(field, e.target.value)}
            placeholder="Page ID or workflow variable"
          />
        ) : (
          <select
            className="wf-props__input"
            value={value}
            onChange={(e) => onChange(field, e.target.value)}
            disabled={loading || !status?.connected}
          >
            <option value="">
              {loading ? "Loading shared pages…" : "Choose a shared page"}
            </option>
            {value && !options.some((o) => o.id === value) && (
              <option value={value}>{value}</option>
            )}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        )}
      </label>
      {!manual && (
        <label className="wf-props__field-label">
          Search shared pages
          <input
            className="wf-props__input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Page title"
          />
        </label>
      )}
      <button
        type="button"
        className="clickup-connection__button"
        onClick={() => setManual(!manual)}
      >
        {manual ? "Choose from shared pages" : "Use an ID or workflow variable"}
      </button>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Try again
          </button>
        </p>
      )}
      {!manual &&
        status?.connected &&
        !loading &&
        !error &&
        !options.length && (
          <p role="status">
            No shared pages found. Share a page with Jarvis in Notion or change
            the search.
          </p>
        )}
      {!manual && more && (
        <p>Showing up to 100 pages. Search by title to narrow the choices.</p>
      )}
      <p className="wf-props__hint">
        Only pages shared with Jarvis are accessible. You can use a page ID from
        an earlier workflow step.
      </p>
    </section>
  );
}
