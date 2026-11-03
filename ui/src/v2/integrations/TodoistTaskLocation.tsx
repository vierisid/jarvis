import React, { useEffect, useState } from "react";
import "./clickup.css";
type Option = { value: string; label: string };
function TodoistChoice({
  kind,
  project,
  value,
  onChange,
  emptyLabel,
}: {
  kind: "projects" | "sections";
  project: string;
  value: string;
  onChange: (v: string) => void;
  emptyLabel: string;
}) {
  const [options, setOptions] = useState<Option[]>([]),
    [error, setError] = useState("");
  const [page, setPage] = useState<string | null>(null),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false),
    [revision, setRevision] = useState(0),
    [manual, setManual] = useState(value.includes("{{"));
  useEffect(() => {
    if (value.includes("{{")) setManual(true);
  }, [value]);
  useEffect(() => {
    let live = true;
    if (kind === "sections" && (!project || project.includes("{{"))) {
      setOptions([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const q = new URLSearchParams({ kind });
    if (project) q.set("project_id", project);
    if (page) q.set("cursor", page);
    fetch("/api/integrations/todoist/options?" + q)
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            "Could not load " + kind + ". Check the connection or enter an ID.",
          );
        return r.json();
      })
      .then((v) => {
        if (live) {
          setOptions((old) => [
            ...new Map<string, Option>(
              [...(page ? old : []), ...v.options].map((o: Option) => [
                o.value,
                o,
              ]),
            ).values(),
          ]);
          setCursor(v.next_cursor);
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
  }, [kind, project, page, revision]);
  const label = kind === "projects" ? "Project" : "Section";
  return (
    <div>
      <label>
        {label} (optional)
        {manual ? (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={label + " ID or workflow variable"}
          />
        ) : (
          <select
            value={value}
            aria-busy={loading}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">
              {loading ? "Loading " + kind + "…" : emptyLabel}
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
        {manual ? "Choose from Todoist" : "Enter ID or variable"}
      </button>
      {cursor && !manual && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setPage(cursor)}
        >
          Load more {kind}
        </button>
      )}
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => setRevision((v) => v + 1)}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
export function TodoistTaskLocation({
  input,
  onChange,
  creating,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  creating: boolean;
}) {
  const project = String(input.project_id ?? "");
  return (
    <section
      className="clickup-location"
      aria-label="Todoist project and section"
    >
      <TodoistChoice
        kind="projects"
        project=""
        value={project}
        emptyLabel={creating ? "Inbox" : "All accessible projects"}
        onChange={(v) => {
          onChange("project_id", v);
          onChange("section_id", "");
        }}
      />
      {creating && project && (
        <TodoistChoice
          key={project}
          kind="sections"
          project={project}
          value={String(input.section_id ?? "")}
          emptyLabel={
            project.includes("{{")
              ? "Enter a section ID or variable"
              : "No section"
          }
          onChange={(v) => onChange("section_id", v)}
        />
      )}
    </section>
  );
}
