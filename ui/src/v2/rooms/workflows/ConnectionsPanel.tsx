import { CONNECTION_PROVIDER_NAMES, connectionProviderForPiece, isConnectionProvider, type ConnectionProvider } from '../../../../../src/integrations/connection-providers';
import { ManagedConnectionRow, type RowState } from '../../integrations/ManagedConnectionRow';
/**
 * Connections panel: list `app_connection` rows + registered Jarvis sources,
 * add / delete connections. Renders inline below the workflows list when the
 * "Connections" tab is active.
 *
 * Secrets stay server-side (the API never returns `value`); this panel only
 * shows metadata + accepts new values via the add form.
 */

import React, { useCallback, useEffect, useState } from "react";
import { CONNECTION_SETUP_EVENT, takePieceSetup, type PieceSetupRequest } from './connection-setup-request';
import { confirmDialog } from "../../ui/ConfirmDialog";
import { requestSettingsTab } from "../../shell/settings-tab-request";
import { openRoom } from "../../router";
import { Button, Chip, Icon } from "../../ui";
import { RefreshCw, Trash2, Plus, KeyRound } from "lucide-react";
import {
  useConnections,
  type AppConnectionType,
  type ConnectionMeta,
} from "./useConnections";
import { OAUTH2_VALUE_HELP, OAUTH2_VALUE_PLACEHOLDER, isOAuth2Type, oauth2RowLabel, pastedOAuth2Warning } from "./connection-oauth";

export function ConnectionsPanel(): React.ReactElement {
  const conn = useConnections();
  const [refreshKey, setRefreshKey] = useState(0);
  const [setup, setSetup] = useState(() => takePieceSetup());
  const [showForm, setShowForm] = useState(() => setup?.kind === 'piece_credentials' && !setup.rowId);
  useEffect(() => {
    const apply = () => { const request = takePieceSetup(); if (request) { setSetup(request); setShowForm(request.kind === 'piece_credentials' && !request.rowId); } };
    window.addEventListener(CONNECTION_SETUP_EVENT, apply);
    return () => window.removeEventListener(CONNECTION_SETUP_EVENT, apply);
  }, []);
  const selectedProvider = setup?.kind === 'hosted_integration' ? setup.provider : null;
  // Providers this instance cannot set up (every hosted-only one on a
  // self-hosted install) collapse into one line instead of a row each (#1246),
  // and providers still on their first status check share one checking line
  // instead of a row and a status region each (#1260). A row that has not
  // reported yet is on its first check too: rows report from an effect, after
  // the first paint, and an empty map must not read as "all shown".
  const [rowStates, setRowStates] = useState<ReadonlyMap<ConnectionProvider, RowState>>(() => new Map());
  const [refusals, setRefusals] = useState<ReadonlyMap<ConnectionProvider, string>>(() => new Map());
  const reportRowState = useCallback((provider: ConnectionProvider, state: RowState | null, reason?: string) => {
    setRowStates(current => {
      if ((current.get(provider) ?? null) === state) return current;
      const next = new Map(current);
      if (state) next.set(provider, state); else next.delete(provider);
      return next;
    });
    // A refused hosted provider's reason, for the one warning line below (#1259).
    setRefusals(current => {
      const value = state === 'refused' ? reason ?? 'Hosted setup is misconfigured on this instance.' : undefined;
      if (current.get(provider) === value) return current;
      const next = new Map(current);
      if (value) next.set(provider, value); else next.delete(provider);
      return next;
    });
  }, []);
  const listed = conn.jarvisSources.flatMap(s => isConnectionProvider(s.id) && s.id !== selectedProvider ? [s.id] : []);
  const rowState = (id: ConnectionProvider): RowState => rowStates.get(id) ?? 'pending';
  const unavailableNames = listed.filter(id => rowState(id) === 'none').map(id => CONNECTION_PROVIDER_NAMES[id]);
  const checking = listed.some(id => rowState(id) === 'pending');
  // One line per distinct reason, naming the providers it stops.
  const refusedGroups = [...listed.reduce((groups, id) => {
    const reason = rowState(id) === 'refused' ? refusals.get(id) : undefined;
    if (reason) groups.set(reason, [...(groups.get(reason) ?? []), CONNECTION_PROVIDER_NAMES[id]]);
    return groups;
  }, new Map<string, string[]>())];
  const [toast, setToast] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const flash = (tone: "ok" | "warn", text: string): void => {
    setToast({ tone, text });
    window.setTimeout(() => setToast(null), 3000);
  };

  return (
    <div className="wf-conn">
      <header className="wf-conn__header">
        <div>
          <h3 className="wf-conn__title">App connections</h3>
          <p className="wf-conn__subtitle">
            {conn.loading
              ? "loading…"
              : `${conn.connections.length} manually added account${conn.connections.length === 1 ? "" : "s"}`}
            {conn.error ? ` · ${conn.error}` : null}
          </p>
        </div>
        <div className="wf-conn__actions">
          <Button variant="ghost" size="sm" onClick={() => { void conn.refresh(); setRefreshKey(n => n + 1); }} title="Refresh">
            <Icon icon={RefreshCw} size={14} /> Refresh
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowForm((s) => !s)}>
            <Icon icon={Plus} size={14} /> {showForm ? "Cancel" : "Add manual connection"}
          </Button>
        </div>
      </header>

      {toast ? <div className={`wf-toast wf-toast--${toast.tone}`}>{toast.text}</div> : null}

      {selectedProvider && <ManagedConnectionRow key={setup?.requestId} provider={selectedProvider} refreshKey={refreshKey} />}
      {conn.jarvisSources.some(s => isConnectionProvider(s.id)) && <div className="wf-conn__managed">
        {(selectedProvider || listed.some(id => rowState(id) === 'shown')) && <p className="wf-conn__subtitle">Connect your apps securely in your browser. Your connected accounts are available to workflow steps.</p>}
        {listed.map(id => <ManagedConnectionRow key={id} provider={id} refreshKey={refreshKey} onCollapsed={reportRowState} />)}
        <p className="wf-conn__subtitle" role="status">{checking ? 'Checking connections...' : ''}</p>
        {refusedGroups.map(([reason, names]) => <p key={reason} className="wf-conn__refused">
          <Chip tone="warn">Setup refused</Chip> {names.join(', ')}: {reason}
        </p>)}
        {unavailableNames.length > 0 && <p className="wf-conn__subtitle">
          One-click setup is not available on this instance for {unavailableNames.join(', ')}.
        </p>}
      </div>}
      {conn.jarvisSources.some(s => !isConnectionProvider(s.id)) && <div className="wf-conn__sources">
        <span className="wf-conn__sources-label">Other registered sources:</span>
        {conn.jarvisSources.filter(s => !isConnectionProvider(s.id)).map(s => <Chip key={s.id} tone="neutral">{s.id}</Chip>)}
        <span className="wf-conn__sources-help">Registration does not confirm an account is connected.</span>
      </div>}

      {showForm ? (
        <AddConnectionForm
          key={setup?.requestId}
          setup={setup?.kind === 'piece_credentials' ? setup : null}
          onSubmit={async (input) => {
            const r = await conn.create(input);
            flash(r.ok ? "ok" : "warn", r.ok ? `Connection "${input.displayName}" added` : `Add failed: ${r.message}`);
            if (r.ok) setShowForm(false);
          }}
        />
      ) : null}

      {conn.connections.length === 0 && !conn.loading ? (
        <div className="wf-conn__empty">
          No manually added accounts. Apps connected above do not need a separate token.
        </div>
      ) : (
        <ul className="wf-conn__list">
          {conn.connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              requestedEdit={setup?.rowId === `account:${c.id}` ? setup.requestId : undefined}
              onDelete={async () => {
                const usage = await fetch(`/api/workflows/connections/${c.id}/dependents`)
                  .then((res) => (res.ok ? res.json() : null)).catch(() => null) as { warning?: string } | null;
                const note = usage?.warning ? `\n\n${usage.warning}` : "";
                if (!await confirmDialog(`Delete connection "${c.displayName}"? Secrets are removed permanently.${note}`)) return;
                const r = await conn.remove(c.id);
                flash(r.ok ? "ok" : "warn", r.ok ? `Deleted "${c.displayName}"${r.warning ? `. ${r.warning}` : ""}` : `Delete failed: ${r.message}`);
              }}
              onUpdate={async (patch) => {
                const r = await conn.update(c.id, patch);
                flash(
                  r.ok ? "ok" : "warn",
                  r.ok ? `Updated "${c.displayName}"` : `Update failed: ${r.message}`,
                );
                return r.ok;
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
  requestedEdit,
  onDelete,
  onUpdate,
}: {
  connection: ConnectionMeta;
  requestedEdit?: string;
  onDelete: () => void;
  onUpdate: (patch: {
    displayName?: string;
    value?: Record<string, unknown>;
    status?: "ACTIVE" | "MISSING" | "ERROR";
  }) => Promise<boolean>;
}): React.ReactElement {
  const [editing, setEditing] = useState(!!requestedEdit);
  useEffect(() => { if (requestedEdit) setEditing(true); }, [requestedEdit]);
  const oauth = oauth2RowLabel(connection);
  return (
    <li className="wf-conn__row">
      <div className="wf-conn__row-summary">
        <div className="wf-conn__row-main">
          <span className="wf-conn__row-name">{connection.displayName}</span>
          <Chip tone="neutral">{connection.type}</Chip>
          <Chip tone={connection.status === "ACTIVE" ? "ok" : "warn"}>{connection.status}</Chip>
          {oauth ? <span title={oauth.title}><Chip tone={oauth.tone}>{oauth.label}</Chip></span> : null}
          <code className="wf-conn__row-extid">{connection.externalId}</code>
        </div>
        <div className="wf-conn__row-meta">
          <span>piece: <code>{connection.pieceName}</code></span>
          <span>updated: {new Date(connection.updated).toLocaleString()}</span>
        </div>
        <div className="wf-conn__row-actions">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing((e) => !e)}
            title="Rotate secret / edit metadata"
          >
            <Icon icon={KeyRound} size={12} /> {editing ? "Cancel" : "Rotate"}
          </Button>
          <Button variant="danger" size="sm" onClick={onDelete} title="Delete connection">
            <Icon icon={Trash2} size={12} /> Delete
          </Button>
        </div>
      </div>
      {editing ? (
        <EditConnectionForm
          connection={connection}
          onSubmit={async (patch) => {
            const ok = await onUpdate(patch);
            if (ok) setEditing(false);
          }}
        />
      ) : null}
    </li>
  );
}

function EditConnectionForm({
  connection,
  onSubmit,
}: {
  connection: ConnectionMeta;
  onSubmit: (patch: {
    displayName?: string;
    value?: Record<string, unknown>;
    status?: "ACTIVE" | "MISSING" | "ERROR";
  }) => Promise<void>;
}): React.ReactElement {
  const [displayName, setDisplayName] = useState<string>(connection.displayName);
  const [status, setStatus] = useState<ConnectionMeta["status"]>(connection.status);
  const [valueText, setValueText] = useState<string>("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (): Promise<void> => {
    const patch: {
      displayName?: string;
      value?: Record<string, unknown>;
      status?: ConnectionMeta["status"];
    } = {};
    if (displayName.trim() && displayName.trim() !== connection.displayName) {
      patch.displayName = displayName.trim();
    }
    if (status !== connection.status) {
      patch.status = status;
    }
    if (valueText.trim().length > 0) {
      try {
        const parsed = JSON.parse(valueText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("value must be a JSON object");
        }
        patch.value = parsed as Record<string, unknown>;
      } catch (e) {
        setParseError((e as Error).message);
        return;
      }
    }
    setParseError(null);
    if (Object.keys(patch).length === 0) {
      setParseError("nothing to update");
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(patch);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="wf-conn__form wf-conn__form--inline">
      <div className="wf-conn__form-row">
        <label>
          Display name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="leave blank to keep current"
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as ConnectionMeta["status"])}
          >
            <option value="ACTIVE">ACTIVE</option>
            <option value="MISSING">MISSING</option>
            <option value="ERROR">ERROR</option>
          </select>
        </label>
      </div>
      <label className="wf-conn__form-value">
        New value (JSON; leave empty to keep existing)
        <textarea
          rows={5}
          value={valueText}
          onChange={(e) => setValueText(e.target.value)}
          placeholder={isOAuth2Type(connection.type) ? OAUTH2_VALUE_PLACEHOLDER : "{}"}
        />
        {isOAuth2Type(connection.type) ? <span className="wf-conn__form-help">{OAUTH2_VALUE_HELP}</span> : null}
        {valueWarning(connection.type, valueText)}
        {parseError ? <span className="wf-conn__form-err">{parseError}</span> : null}
      </label>
      <div className="wf-conn__form-actions">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleSubmit()}
          disabled={submitting}
        >
          {submitting ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

/** The not-refreshed warning for a value being typed, once it parses as a JSON object. */
function valueWarning(type: AppConnectionType, valueText: string): React.ReactElement | null {
  let parsed: unknown;
  try { parsed = JSON.parse(valueText); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const warning = pastedOAuth2Warning(type, parsed as Record<string, unknown>);
  return warning ? <span className="wf-conn__form-warn">{warning}</span> : null;
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
  setup,
  onSubmit,
}: {
  setup?: PieceSetupRequest | null;
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
  const [type, setType] = useState<AppConnectionType>((setup?.authType as AppConnectionType) ?? "OAUTH2");
  const [pieceName, setPieceName] = useState(setup?.pieceName ?? "");
  const [pieceVersion, setPieceVersion] = useState(setup?.pieceVersion ?? "0.0.0");
  const [valueText, setValueText] = useState(setup && !["OAUTH2", "PLATFORM_OAUTH2", "CLOUD_OAUTH2"].includes(setup.authType) ? '{}' : '{"access_token": ""}');
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [manualProvider, setManualProvider] = useState<string | null>(null);
  const provider = connectionProviderForPiece(pieceName.trim());
  const useManaged = provider && manualProvider !== provider;
  const [administratorSetup, setAdministratorSetup] = useState(false);


  const handleSubmit = async (): Promise<void> => {
    if (useManaged) return;
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

  if (setup && useManaged) return <ManagedConnectionRow key={provider} provider={provider}
    onManualSetup={() => setManualProvider(provider)} />;
  // An OAuth piece with no browser connection of its own: explain before offering a raw credential form.
  if (setup && !provider && !administratorSetup && ["OAUTH2", "PLATFORM_OAUTH2", "CLOUD_OAUTH2"].includes(setup.authType)) {
    return <OAuthSetupGuide pieceName={setup.pieceName} onAdministratorSetup={() => setAdministratorSetup(true)} />;
  }

  return (
    <div className="wf-conn__form">
      {setup && administratorSetup ? <p role="note">Administrator credential setup. Use a provider-authorized token with the permissions required by this connector. Saving credentials does not verify account access. Never paste credentials in chat.</p> : null}
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
      {useManaged ? <ManagedConnectionRow key={provider} provider={provider} onManualSetup={() => setManualProvider(provider)} /> : <>
      <label className="wf-conn__form-value">
        Value (JSON)
        <textarea
          rows={5}
          value={valueText}
          onChange={(e) => setValueText(e.target.value)}
          placeholder={isOAuth2Type(type) ? OAUTH2_VALUE_PLACEHOLDER : "{}"}
        />
        {isOAuth2Type(type) ? <span className="wf-conn__form-help">{OAUTH2_VALUE_HELP}</span> : null}
        {valueWarning(type, valueText)}
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
      </>}
    </div>
  );
}

/** Google pieces whose actions the Settings Google grant (read-only Gmail and Calendar) can serve. */
const GOOGLE_READ_PIECES: Record<string, string> = {
  '@activepieces/piece-gmail': 'Gmail',
  '@activepieces/piece-google-calendar': 'Google Calendar',
};
/** Google pieces that grant cannot authorize at all. */
const GOOGLE_WRITE_PIECES: Record<string, string> = {
  '@activepieces/piece-google-sheets': 'Google Sheets',
  '@activepieces/piece-google-drive': 'Google Drive',
};

/**
 * An OAuth piece reached from a setup action that has no browser connection in
 * Jarvis (hosted providers get ManagedConnectionRow instead). This form only
 * stores pasted credentials; there is no universal piece OAuth broker. Only
 * Google is connected from Settings > Integrations, and that grant is
 * read-only Gmail and Calendar on hosted and self-hosted alike.
 */
export function OAuthSetupGuide({ pieceName, onAdministratorSetup, onOpenIntegrations = openIntegrations }: { pieceName: string; onAdministratorSetup(): void; onOpenIntegrations?(): void }) {
  const googleRead = GOOGLE_READ_PIECES[pieceName], googleWrite = GOOGLE_WRITE_PIECES[pieceName];
  const sheets = pieceName === '@activepieces/piece-google-sheets';
  return <section className="wf-conn__form" aria-labelledby="oauth-setup-heading">
    <h4 id="oauth-setup-heading">{googleRead || googleWrite ? `Connect ${googleRead ?? googleWrite}` : 'Connect an account'}</h4>
    {googleRead
      ? <p>Connect Google in Settings, under Integrations. That connection grants read-only Gmail and Calendar access, so {googleRead} steps that send, change or delete need an administrator credential instead.</p>
      : googleWrite
        ? <p>The Google connection in Settings grants read-only Gmail and Calendar access. It cannot authorize {sheets ? 'writing to Google Sheets' : 'Google Drive'}.</p>
        : <p>This connector has no browser sign-in in Jarvis. Installing a connector does not connect an account.</p>}
    {googleRead ? null : <p>Keep your workflow as a draft. Whoever administers this Jarvis can save an authorized credential for this connector here; then refresh and select it.</p>}
    {sheets ? <p>For spreadsheet writes, that credential needs a Google OAuth grant with Sheets write access and access to the destination spreadsheet. A Gmail or Calendar grant is not sufficient.</p> : null}
    <div className="wf-conn__form-actions">
      {googleRead ? <Button variant="primary" size="sm" onClick={onOpenIntegrations}>Open Integrations</Button> : null}
      <Button variant="ghost" size="sm" onClick={onAdministratorSetup}>Administrator credential setup</Button>
    </div>
  </section>;
}

function openIntegrations(): void { requestSettingsTab('integrations'); openRoom('settings'); }
