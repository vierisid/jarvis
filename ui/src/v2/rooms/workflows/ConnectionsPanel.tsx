/**
 * Connections panel: list `app_connection` rows + registered Jarvis sources,
 * add / delete connections. Renders inline below the workflows list when the
 * "Connections" tab is active.
 *
 * Secrets stay server-side (the API never returns `value`); this panel only
 * shows metadata + accepts new values via the add form.
 */

import React, { useState } from "react";
import { Button, Chip, Icon } from "../../ui";
import { RefreshCw, Trash2, Plus } from "lucide-react";
import {
  useConnections,
  type AppConnectionType,
  type ConnectionMeta,
} from "./useConnections";

export function ConnectionsPanel(): React.ReactElement {
  const conn = useConnections();
  const [showForm, setShowForm] = useState(false);
  const [toast, setToast] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const flash = (tone: "ok" | "warn", text: string): void => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3000);
  };

  return (
    <div className="wf-conn">
      <header className="wf-conn__header">
        <div>
          <h3 className="wf-conn__title">Piece connections</h3>
          <p className="wf-conn__subtitle">
            {conn.loading
              ? "loading…"
              : `${conn.connections.length} stored · ${conn.jarvisSources.length} Jarvis source${conn.jarvisSources.length === 1 ? "" : "s"} registered`}
            {conn.error ? ` · ${conn.error}` : null}
          </p>
        </div>
        <div className="wf-conn__actions">
          <Button variant="ghost" size="sm" onClick={() => void conn.refresh()} title="Refresh">
            <Icon icon={RefreshCw} size={14} /> Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowForm((s) => !s)}>
            <Icon icon={Plus} size={14} /> {showForm ? "Cancel" : "Add"}
          </Button>
        </div>
      </header>

      {toast ? <div className={`wf-toast wf-toast--${toast.tone}`}>{toast.text}</div> : null}

      {conn.jarvisSources.length > 0 ? (
        <div className="wf-conn__sources">
          <span className="wf-conn__sources-label">Reusable Jarvis credentials:</span>
          {conn.jarvisSources.map((s) => (
            <Chip key={s.id} tone="ok">
              <code>jarvis:{s.id}</code>
            </Chip>
          ))}
          <span className="wf-conn__sources-help">
            -- pieces can use these external ids in their auth field without a stored row.
          </span>
        </div>
      ) : null}

      {showForm ? (
        <AddConnectionForm
          onSubmit={async (input) => {
            const r = await conn.create(input);
            flash(r.ok ? "ok" : "warn", r.ok ? `Connection "${input.displayName}" added` : `Add failed: ${r.message}`);
            if (r.ok) setShowForm(false);
          }}
        />
      ) : null}

      {conn.connections.length === 0 && !conn.loading ? (
        <div className="wf-conn__empty">
          No connections stored. Use Add to wire OAuth tokens / API keys for pieces.
        </div>
      ) : (
        <ul className="wf-conn__list">
          {conn.connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              onDelete={async () => {
                if (!window.confirm(`Delete connection "${c.displayName}"? Secrets are removed permanently.`)) return;
                const r = await conn.remove(c.id);
                flash(r.ok ? "ok" : "warn", r.ok ? `Deleted "${c.displayName}"` : `Delete failed: ${r.message}`);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectionRow({
  connection,
  onDelete,
}: {
  connection: ConnectionMeta;
  onDelete: () => void;
}): React.ReactElement {
  return (
    <li className="wf-conn__row">
      <div className="wf-conn__row-main">
        <span className="wf-conn__row-name">{connection.displayName}</span>
        <Chip tone="neutral">{connection.type}</Chip>
        <Chip tone={connection.status === "ACTIVE" ? "ok" : "warn"}>{connection.status}</Chip>
        <code className="wf-conn__row-extid">{connection.externalId}</code>
      </div>
      <div className="wf-conn__row-meta">
        <span>piece: <code>{connection.pieceName}</code></span>
        <span>created: {new Date(connection.created).toLocaleString()}</span>
      </div>
      <Button variant="danger" size="sm" onClick={onDelete} title="Delete connection">
        <Icon icon={Trash2} size={12} /> Delete
      </Button>
    </li>
  );
}

const TYPES: AppConnectionType[] = [
  "OAUTH2",
  "PLATFORM_OAUTH2",
  "CLOUD_OAUTH2",
  "SECRET_TEXT",
  "BASIC_AUTH",
  "CUSTOM_AUTH",
  "NO_AUTH",
];

function AddConnectionForm({
  onSubmit,
}: {
  onSubmit: (input: {
    externalId: string;
    displayName: string;
    type: AppConnectionType;
    pieceName: string;
    pieceVersion: string;
    value: Record<string, unknown>;
  }) => Promise<void>;
}): React.ReactElement {
  const [externalId, setExternalId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [type, setType] = useState<AppConnectionType>("OAUTH2");
  const [pieceName, setPieceName] = useState("");
  const [pieceVersion, setPieceVersion] = useState("0.0.0");
  const [valueText, setValueText] = useState('{"access_token": ""}');
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(valueText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("value must be a JSON object");
      }
      value = parsed as Record<string, unknown>;
    } catch (e) {
      setParseError((e as Error).message);
      return;
    }
    setParseError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        externalId: externalId.trim(),
        displayName: displayName.trim(),
        type,
        pieceName: pieceName.trim(),
        pieceVersion: pieceVersion.trim() || "0.0.0",
        value,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="wf-conn__form">
      <div className="wf-conn__form-row">
        <label>
          External id
          <input
            value={externalId}
            onChange={(e) => setExternalId(e.target.value)}
            placeholder="my-gmail"
          />
        </label>
        <label>
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="My Gmail"
          />
        </label>
      </div>
      <div className="wf-conn__form-row">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as AppConnectionType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Piece name
          <input
            value={pieceName}
            onChange={(e) => setPieceName(e.target.value)}
            placeholder="@activepieces/piece-gmail"
          />
        </label>
        <label>
          Piece version
          <input
            value={pieceVersion}
            onChange={(e) => setPieceVersion(e.target.value)}
            placeholder="0.0.0"
          />
        </label>
      </div>
      <label className="wf-conn__form-value">
        Value (JSON)
        <textarea
          rows={5}
          value={valueText}
          onChange={(e) => setValueText(e.target.value)}
          placeholder='{"access_token": "...", "refresh_token": "..."}'
        />
        {parseError ? <span className="wf-conn__form-err">{parseError}</span> : null}
      </label>
      <div className="wf-conn__form-actions">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={submitting || !externalId.trim() || !displayName.trim() || !pieceName.trim()}
        >
          {submitting ? "Adding…" : "Add connection"}
        </Button>
      </div>
    </div>
  );
}
