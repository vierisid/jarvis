import React, { useEffect, useState } from "react";
import "./clickup.css";
type Option = { value: string; label: string };
export function WrikeFolder({
  input,
  onChange,
  required,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  required: boolean;
}) {
  const value = String(input.folderId ?? "");
  const [manual, setManual] = useState(value.includes("{{")),
    [term, setTerm] = useState("");
  const [query, setQuery] = useState<{
    title: string;
    cursor: string | null;
    revision: number;
  } | null>(null);
  const [options, setOptions] = useState<Option[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (value.includes("{{")) setManual(true);
  }, [value]);
  useEffect(() => {
    if (!query) return;
    let live = true;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ title: query.title });
    if (query.cursor) params.set("cursor", query.cursor);
    fetch("/api/integrations/wrike/folders?" + params)
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            "Could not load folders. Check your connection or enter an API ID.",
          );
        return r.json();
      })
      .then((data) => {
        if (live) {
          setOptions(
            (old) =>
              [
                ...new Map(
                  [...(query.cursor ? old : []), ...data.options].map(
                    (v: Option) => [v.value, v],
                  ),
                ).values(),
              ] as Option[],
          );
          setCursor(data.next_cursor);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [query]);
  return (
    <section className="clickup-location" aria-label="Wrike folder">
      {!manual && (
        <>
          <label>
            Find a folder or project
            <input
              value={term}
              maxLength={200}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Folder or project name"
            />
          </label>
          <button
            type="button"
            disabled={!term.trim() || loading}
            onClick={() =>
              setQuery({
                title: term.trim(),
                cursor: null,
                revision: (query?.revision ?? 0) + 1,
              })
            }
          >
            {loading ? "Searching…" : "Search folders"}
          </button>
        </>
      )}
      <label>
        Folder or project{required ? " *" : " (optional)"}
        {manual ? (
          <input
            value={value}
            required={required}
            onChange={(e) => onChange("folderId", e.target.value)}
            placeholder="Wrike API ID or workflow variable"
          />
        ) : (
          <select
            value={value}
            required={required}
            aria-busy={loading}
            onChange={(e) => onChange("folderId", e.target.value)}
          >
            <option value="">
              {required
                ? "Choose a folder or project"
                : "All accessible folders"}
            </option>
            {value && !options.some((o) => o.value === value) && (
              <option value={value}>{value}</option>
            )}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </label>
      <button type="button" onClick={() => setManual(!manual)}>
        {manual ? "Choose from Wrike" : "Enter ID or variable"}
      </button>
      {query && !loading && !error && !options.length && !manual && (
        <p role="status">
          No folders matched. Try another name or enter an API ID.
        </p>
      )}
      {cursor && !manual && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setQuery((q) => (q ? { ...q, cursor } : null))}
        >
          Load more folders
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() =>
              setQuery((q) => (q ? { ...q, revision: q.revision + 1 } : null))
            }
          >
            Try again
          </button>
        </p>
      )}
    </section>
  );
}
