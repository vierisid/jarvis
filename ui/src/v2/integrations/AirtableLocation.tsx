import React, { useEffect, useRef, useState } from "react";
import "./airtable.css";
type Option = { value: string; label: string };
type Table = {
  id: string;
  name: string;
  fields: Array<{ id: string; name: string; type: string }>;
  views: Array<{ id: string; name: string }>;
};
export function AirtableLocation({
  input,
  onChange,
  search = false,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: string) => void;
  search?: boolean;
}) {
  const base_id = String(input.base_id ?? ""),
    table = String(input.table_id_or_name ?? "");
  const [bases, setBases] = useState<Option[]>([]),
    [tables, setTables] = useState<Table[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [manual, setManual] = useState(
    base_id.includes("{{") || table.includes("{{"),
  );
  const generation = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    setTables([]);
    const load = async () => {
      try {
        const get = async (query: string) => {
          const r = await fetch("/api/integrations/airtable/options" + query);
          const v = await r.json();
          if (!r.ok) throw Error(v.error || "Could not load Airtable choices.");
          return v;
        };
        const root = await get("");
        if (!live) return;
        if (generation.current && generation.current !== root.generation) {
          setBases([]);
          generation.current = null;
          throw Error(
            "Airtable account changed. Reload and choose the base and table again.",
          );
        }
        generation.current = root.generation;
        setBases(root.options);
        if (base_id && !base_id.includes("{{")) {
          const v = await get(
            "?base=" +
              encodeURIComponent(base_id) +
              "&generation=" +
              encodeURIComponent(root.generation),
          );
          if (live) setTables(v.tables);
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof Error ? e.message : "Could not load Airtable choices.",
          );
      } finally {
        if (live) setBusy(false);
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [base_id, revision]);
  const selected = tables.find((t) => t.id === table);
  const choices = (
    label: string,
    key: string,
    value: string,
    options: Option[],
    optional = false,
  ) => (
    <label>
      {label}
      {manual ? (
        <input
          value={value}
          onChange={(e) => onChange(key, e.target.value)}
          placeholder={label + " ID or workflow variable"}
        />
      ) : (
        <select
          value={value}
          disabled={busy || (key !== "base_id" && !base_id)}
          onChange={(e) => {
            onChange(key, e.target.value);
            if (key === "base_id") {
              onChange("table_id_or_name", "");
              onChange("fields", "");
              onChange("record_id", "");
            }
            if (key === "base_id" || key === "table_id_or_name") {
              onChange("search_field", "");
              onChange("view", "");
              if (key === "table_id_or_name") {
                onChange("fields", "");
                onChange("record_id", "");
              }
            }
          }}
        >
          <option value="">
            {optional ? "All records" : "Choose a " + label.toLowerCase()}
          </option>
          {value && !options.some((o) => o.value === value) && (
            <option value={value}>{value} (saved selection)</option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </label>
  );
  return (
    <section
      className="airtable-location"
      aria-label="Airtable record location"
    >
      {choices("Base", "base_id", base_id, bases)}
      {choices(
        "Table",
        "table_id_or_name",
        table,
        tables.map((t) => ({ value: t.id, label: t.name })),
      )}
      {search &&
        choices(
          "Search field",
          "search_field",
          String(input.search_field ?? ""),
          (selected?.fields ?? []).map((f) => ({ value: f.id, label: f.name })),
        )}
      {search &&
        choices(
          "View",
          "view",
          String(input.view ?? ""),
          (selected?.views ?? []).map((v) => ({ value: v.id, label: v.name })),
          true,
        )}
      {busy && <p role="status">Loading Airtable choices…</p>}
      {error && <p role="alert">{error}</p>}
      {!busy && !error && bases.length === 0 && (
        <p>
          No bases are shared with Jarvis. Manage the Airtable connection to
          grant access.
        </p>
      )}
      {selected && !search && (
        <details>
          <summary>Field names and IDs</summary>
          <ul>
            {selected.fields.map((f) => (
              <li key={f.id}>
                {f.name}: <code>{f.id}</code> ({f.type})
              </li>
            ))}
          </ul>
          <p>
            Use existing field names or IDs in Fields. Text, number, checkbox,
            date and select values are supported. Select choices must already
            exist.
          </p>
        </details>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          generation.current = null;
          setRevision((v) => v + 1);
        }}
      >
        Reload bases
      </button>
      <button type="button" onClick={() => setManual((v) => !v)}>
        {manual ? "Choose from Airtable" : "Enter IDs or workflow variables"}
      </button>
    </section>
  );
}
