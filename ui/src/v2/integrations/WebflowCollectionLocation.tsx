import React, { useEffect, useState } from "react";
import type { WebflowStatus } from "./WebflowConnection";
import "./clickup.css";
type Field = {
  slug: string;
  displayName: string;
  type: string;
  isRequired: boolean;
  isEditable: boolean;
  options: Array<{ id: string; name: string }>;
};
const supported = [
  "PlainText",
  "RichText",
  "Email",
  "Link",
  "Phone",
  "Color",
  "Number",
  "Switch",
  "DateTime",
  "Option",
];
function JsonFields({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const serialized = JSON.stringify(value ?? {}, null, 2);
  const [text, setText] = useState(serialized),
    [error, setError] = useState("");
  useEffect(() => {
    setText(serialized);
    setError("");
  }, [serialized]);
  return (
    <label>
      Collection fields (JSON)
      <textarea
        value={text}
        rows={6}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
              throw Error();
            onChange(parsed);
            setError("");
          } catch {
            setError(
              "Enter a JSON object with collection field slugs. Your last valid fields are still saved.",
            );
          }
        }}
      />
      <span>
        Use field slugs as keys. Workflow variables can be used as values.
      </span>
      {error && <span role="alert">{error}</span>}
    </label>
  );
}
export function WebflowCollectionLocation({
  input,
  onChange,
  action,
  status,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  action: string;
  status: WebflowStatus | null;
}) {
  const [collections, setCollections] = useState<
      Array<{ id: string; name: string }>
    >([]),
    [fields, setFields] = useState<Field[]>([]);
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [manual, setManual] = useState(false),
    [revision, setRevision] = useState(0);
  const site = String(input.site_id ?? ""),
    collection = String(input.collection_id ?? ""),
    generation = status?.generation;
  const writing = ["create_collection_item", "update_collection_item"].includes(
    action,
  );
  const variable = site.includes("{{") || collection.includes("{{");
  useEffect(() => {
    let live = true;
    const abort = new AbortController();
    setCollections([]);
    setFields([]);
    setError("");
    setLoading(false);
    if (!status?.connected || !generation || !site || variable) return;
    setLoading(true);
    const get = async (params: URLSearchParams) => {
      const response = await fetch(
        "/api/integrations/webflow/options?" + params,
        { signal: abort.signal },
      );
      const data = await response.json();
      if (!response.ok)
        throw Error(data.error || "Could not load Webflow collections.");
      if (data.generation !== generation)
        throw Error("Your account changed. Check the Webflow connection.");
      return data;
    };
    void (async () => {
      try {
        const choices = await get(new URLSearchParams({ site, generation }));
        if (!live) return;
        setCollections(choices.collections);
        if (collection) {
          const schema = await get(
            new URLSearchParams({ site, collection, generation }),
          );
          if (live) setFields(schema.fields);
        }
      } catch (e) {
        if (live)
          setError(
            e instanceof Error
              ? e.message
              : "Could not load Webflow collections.",
          );
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
  }, [site, collection, generation, status?.connected, variable, revision]);
  const values =
    input.collection_fields &&
    typeof input.collection_fields === "object" &&
    !Array.isArray(input.collection_fields)
      ? (input.collection_fields as Record<string, unknown>)
      : {};
  const changeField = (key: string, value: unknown) => {
    const next = { ...values };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange("collection_fields", next);
  };
  const changeLocation = (key: string, value: string) => {
    onChange(key, value);
    if (key === "site_id") onChange("collection_id", "");
    onChange("collection_fields", {});
    onChange("collection_item_id", "");
  };
  return (
    <section className="clickup-location" aria-label="Webflow CMS location">
      <p>
        Changes stay in draft in your site's primary language. Review and
        publish them in Webflow.
      </p>
      {(
        [
          ["site_id", "Site", site, status?.workspaces ?? []],
          ["collection_id", "Collection", collection, collections],
        ] as const
      ).map(([key, label, value, options]) => (
        <label key={key}>
          {label}
          {manual || variable ? (
            <input
              value={value}
              onChange={(e) => changeLocation(key, e.target.value)}
              placeholder={label + " ID or workflow variable"}
            />
          ) : (
            <select
              value={value}
              disabled={
                !status?.connected ||
                (key === "collection_id" && (!site || loading))
              }
              onChange={(e) => changeLocation(key, e.target.value)}
            >
              <option value="">Choose {label.toLowerCase()}</option>
              {value && !options.some((o) => o.id === value) && (
                <option value={value}>{value}</option>
              )}
              {options.map((o) => (
                <option value={o.id} key={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
      <button type="button" onClick={() => setManual((v) => !v)}>
        {manual ? "Choose from Webflow" : "Enter IDs or variables"}
      </button>
      {loading && <p role="status">Loading collections and fields…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Try again
          </button>
        </p>
      )}
      {!loading &&
        !error &&
        site &&
        !variable &&
        status?.connected &&
        !collections.length && (
          <p>
            No collections found. Create a CMS collection in Webflow, then try
            again.{" "}
            <button type="button" onClick={() => setRevision((v) => v + 1)}>
              Refresh collections
            </button>
          </p>
        )}
      {writing && (manual || variable) ? (
        <JsonFields
          value={input.collection_fields}
          onChange={(v) => onChange("collection_fields", v)}
        />
      ) : (
        writing &&
        fields
          .filter((f) => f.isEditable)
          .map((field) => {
            const value = values[field.slug],
              required =
                field.isRequired && action === "create_collection_item";
            if (!supported.includes(field.type))
              return (
                <p key={field.slug}>
                  {field.displayName}: {field.type} fields are not supported
                  yet.
                  {required
                    ? " This collection requires this field, so drafts cannot be created here yet."
                    : ""}
                </p>
              );
            return (
              <label key={field.slug}>
                {field.displayName}
                {required ? " *" : ""}
                {field.type === "Switch" ? (
                  <select
                    value={value === undefined ? "" : String(value)}
                    onChange={(e) =>
                      changeField(
                        field.slug,
                        e.target.value === ""
                          ? undefined
                          : e.target.value === "true",
                      )
                    }
                  >
                    <option value="">Leave unchanged</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : field.type === "Option" ? (
                  <select
                    value={String(value ?? "")}
                    required={required}
                    onChange={(e) =>
                      changeField(field.slug, e.target.value || undefined)
                    }
                  >
                    <option value="">Choose an option</option>
                    {field.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                ) : field.type === "RichText" ? (
                  <textarea
                    value={String(value ?? "")}
                    required={required}
                    rows={4}
                    onChange={(e) => changeField(field.slug, e.target.value)}
                  />
                ) : (
                  <input
                    value={String(value ?? "")}
                    required={required}
                    placeholder={
                      field.type === "DateTime"
                        ? "2026-10-29T12:00:00Z"
                        : field.type === "Number"
                          ? "Number or workflow variable"
                          : "Text or workflow variable"
                    }
                    onChange={(e) =>
                      changeField(
                        field.slug,
                        field.type === "Number" &&
                          e.target.value.trim() &&
                          !isNaN(Number(e.target.value))
                          ? Number(e.target.value)
                          : e.target.value,
                      )
                    }
                  />
                )}
                {!required && value !== undefined && (
                  <button
                    type="button"
                    onClick={() => changeField(field.slug, undefined)}
                  >
                    Leave {field.displayName} unchanged
                  </button>
                )}
              </label>
            );
          })
      )}
    </section>
  );
}
