import React, { useEffect, useState } from "react";
import "./clickup.css";
type Option = { value: string; label: string };
function MondayChoice({
  kind,
  board,
  value,
  onChange,
  emptyLabel,
}: {
  kind: "boards" | "groups";
  board: string;
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
    if (kind === "groups" && (!board || board.includes("{{"))) {
      setOptions([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const q = new URLSearchParams({ kind });
    if (board) q.set("board_id", board);
    if (page) q.set("cursor", page);
    fetch("/api/integrations/monday/options?" + q)
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
  }, [kind, board, page, revision]);
  const label = kind === "boards" ? "Board" : "Group";
  return (
    <div>
      <label>
        {label}
        {kind === "boards" ? " (required)" : " (optional)"}
        {manual ? (
          <input
            value={value}
            required={kind === "boards"}
            onChange={(e) => onChange(e.target.value)}
            placeholder={label + " ID or workflow variable"}
          />
        ) : (
          <select
            value={value}
            required={kind === "boards"}
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
        {manual ? "Choose from monday.com" : "Enter ID or variable"}
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
export function MondayBoardLocation({
  input,
  onChange,
  creating,
  columns = false,
}: {
  input: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  creating: boolean;
  columns?: boolean;
}) {
  const board = String(input.board_id ?? "");
  return (
    <section
      className="clickup-location"
      aria-label="monday.com board and group"
    >
      <MondayChoice
        kind="boards"
        board=""
        value={board}
        emptyLabel="Choose a board"
        onChange={(v) => {
          onChange("board_id", v);
          onChange("group_id", "");
          onChange("item_id", "");
          onChange("column_values", {});
        }}
      />
      {columns && board && !board.includes("{{") && (
        <MondayColumns key={board} board={board} />
      )}
      {creating && board && (
        <MondayChoice
          key={board}
          kind="groups"
          board={board}
          value={String(input.group_id ?? "")}
          emptyLabel={
            board.includes("{{")
              ? "Enter a group ID or variable"
              : "Default group"
          }
          onChange={(v) => onChange("group_id", v)}
        />
      )}
    </section>
  );
}

function MondayColumns({ board }: { board: string }) {
  const [columns, setColumns] = useState<Array<Option & { type: string }>>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    fetch(
      "/api/integrations/monday/options?" +
        new URLSearchParams({ kind: "columns", board_id: board }),
    )
      .then(async (r) => {
        if (!r.ok) throw Error();
        return r.json();
      })
      .then((v) => {
        if (live) setColumns(v.options);
      })
      .catch(() => {
        if (live)
          setError(
            "Could not load column IDs. Check the board and connection.",
          );
      });
    return () => {
      live = false;
    };
  }, [board]);
  return (
    <details>
      <summary>Column IDs and supported values</summary>
      <p>
        Use a JSON object with column IDs as keys. Empty values preserve
        existing fields. Supported writes: text, long text, numbers, checkbox,
        date and existing status labels.
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : columns.length ? (
        <ul>
          {columns.map((c) => (
            <li key={c.value}>
              {c.label}: <code>{c.value}</code> ({c.type})
            </li>
          ))}
        </ul>
      ) : (
        <p role="status">Loading columns…</p>
      )}
    </details>
  );
}
