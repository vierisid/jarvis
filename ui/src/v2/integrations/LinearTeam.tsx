import React, { useEffect, useState } from "react";
import "./clickup.css";
type Option = { value: string; label: string };
export function LinearTeam({
  input,
  onChange,
  required,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  required: boolean;
}) {
  const [options, setOptions] = useState<Option[]>([]),
    [error, setError] = useState("");
  const [cursor, setCursor] = useState<string | null>(null),
    [page, setPage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [manual, setManual] = useState(String(input.team_id ?? "").includes("{{"));
  const value = String(input.team_id ?? "");
  useEffect(() => { if (value.includes("{{")) setManual(true); }, [value]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    fetch(
      "/api/integrations/linear/teams" +
        (page ? "?cursor=" + encodeURIComponent(page) : ""),
    )
      .then(async (r) => {
        if (!r.ok)
          throw Error(
            "Could not load teams. Check your connection or enter a team ID.",
          );
        return r.json();
      })
      .then((v) => {
        if (live) {
          setOptions(
            (old) =>
              [
                ...new Map(
                  [...(page ? old : []), ...v.options].map((o: Option) => [
                    o.value,
                    o,
                  ]),
                ).values(),
              ] as Option[],
          );
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
  }, [page, revision]);
  return (
    <section className="clickup-location" aria-label="Linear team">
      <label>
        Team{required ? " *" : " (optional)"}
        {manual ? (
          <input
            value={value}
            required={required}
            onChange={(e) => onChange("team_id", e.target.value)}
            placeholder="Team UUID or workflow variable"
          />
        ) : (
          <select
            value={value}
            required={required}
            aria-busy={loading}
            onChange={(e) => onChange("team_id", e.target.value)}
          >
            <option value="">
              {loading
                ? "Loading teams…"
                : required
                  ? "Choose a team"
                  : "All accessible teams"}
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
        {manual ? "Choose from Linear" : "Enter ID or variable"}
      </button>
      {cursor && !manual && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setPage(cursor)}
        >
          Load more teams
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
    </section>
  );
}
