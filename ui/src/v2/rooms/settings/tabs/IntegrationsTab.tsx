import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { ClickUpConnection } from "../../../integrations/ClickUpConnection";
import { MailchimpConnection } from "../../../integrations/MailchimpConnection";
import { AsanaConnection } from "../../../integrations/AsanaConnection";
import { ZoomConnection } from "../../../integrations/ZoomConnection";
import { GitLabConnection } from "../../../integrations/GitLabConnection";
import { PipedriveConnection } from "../../../integrations/PipedriveConnection";
import { HelpScoutConnection } from "../../../integrations/HelpScoutConnection";
import { MondayConnection } from "../../../integrations/MondayConnection";
import { TodoistConnection } from "../../../integrations/TodoistConnection";
import { FigmaConnection } from "../../../integrations/FigmaConnection";
import { WebflowConnection } from "../../../integrations/WebflowConnection";
import { GitHubConnection } from "../../../integrations/GitHubConnection";
import { DropboxConnection } from "../../../integrations/DropboxConnection";
import { TrelloConnection } from "../../../integrations/TrelloConnection";
import { LinearConnection } from "../../../integrations/LinearConnection";
import { WrikeConnection } from "../../../integrations/WrikeConnection";
import { TypeformConnection } from "../../../integrations/TypeformConnection";
import { AirtableConnection } from "../../../integrations/AirtableConnection";
import { SlackConnection } from "../../../integrations/SlackConnection";
import { IntercomConnection } from "../../../integrations/IntercomConnection";
import { CalendlyConnection } from "../../../integrations/CalendlyConnection";
import { NotionConnection } from "../../../integrations/NotionConnection";
import type { SettingsHook } from "../useSettingsData";
import { confirmDialog } from "../../../ui/ConfirmDialog";

/** #957: what turning Gmail sending on grants, said before the owner chooses it. */
export const GMAIL_SEND_GRANT =
  "Lets Jarvis send mail as you from this Google account (Google's gmail.send permission). Every send still waits for your approval on a card before it goes out. Leave it off to keep the connection read-only.";

export function IntegrationsTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const g = data.google;
  const clientIdInput = useId(), clientSecretInput = useId();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [phase, setPhase] = useState<"idle" | "saving" | "authenticating">("idle");
  const sendInput = useId();
  const [allowSend, setAllowSend] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [googleRedirectUri, setGoogleRedirectUri] = useState(
    () => `${window.location.origin}/api/auth/google/callback`,
  );
  const [originWarnings, setOriginWarnings] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/system/external-origin")
      .then((response) => response.json())
      .then((result: { google_callback?: string; warnings?: string[] }) => {
        if (cancelled) return;
        if (result.google_callback) setGoogleRedirectUri(result.google_callback);
        setOriginWarnings(result.warnings ?? []);
      })
      .catch(() => { /* keep the browser-origin guess; may differ from the daemon's resolved origin */ });
    return () => { cancelled = true; };
  }, []);

  // Listen for the OAuth popup completion event
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin === window.location.origin && event.data === "google-auth-complete") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setPhase("idle");
        onToast("Connected. Gmail and Calendar observers are starting.", "ok");
        data.refresh();
      }
    },
    [data, onToast],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  const handleSaveCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      onToast("Both Client ID and Client Secret are required.", "warn");
      return;
    }
    setPhase("saving");
    const r = await data.saveGoogleCredentials({
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
    });
    onToast(r.message, r.ok ? "ok" : "warn");
    if (r.ok) {
      setClientId("");
      setClientSecret("");
    }
    setPhase("idle");
  };

  const handleConnect = async (send: boolean) => {
    const r = await data.initGoogleAuth({ send });
    if (!r.ok) {
      onToast(r.message, "warn");
      return;
    }
    setPhase("authenticating");
    window.open(r.auth_url, "google-auth", "width=600,height=700");

    // Polling fallback (in case the popup can't postMessage back)
    let polls = 0;
    pollRef.current = setInterval(async () => {
      polls++;
      if (polls > 40) {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
        setPhase("idle");
        onToast("Authorization timed out. Try again.", "warn");
        return;
      }
      try {
        const status = await fetch("/api/auth/google/status").then((r) => r.json());
        if (status?.is_authenticated) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setPhase("idle");
          onToast(
            "Connected. Gmail and Calendar observers are starting.",
            "ok",
          );
          data.refresh();
        }
      } catch {
        /* poll error — ignore */
      }
    }, 3000);
  };

  // Connected already: a change of what the grant allows is a new consent.
  const handleAllowSend = async () => {
    if (!await confirmDialog(`Allow Jarvis to send mail from this Google account? ${GMAIL_SEND_GRANT} Google will ask you to connect again.`)) return;
    await handleConnect(true);
  };
  const handleReadOnly = async () => {
    if (!await confirmDialog("Connect again read-only? Workflow steps that send mail from this account will stop until sending is allowed again.")) return;
    await handleConnect(false);
  };

  const handleDisconnect = async () => {
    if (!await confirmDialog("Disconnect Google? You'll need to re-authorize to reconnect.")) return;
    const r = await data.disconnectGoogle();
    onToast(r.message, r.ok ? "ok" : "warn");
  };

  return (
    <div>
      <MailchimpConnection optional />
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Google</h3>
            <div className="v2-set__section-sub">
              {g?.managed
                ? g.can_send
                  ? "Gmail (read and send) and Google Calendar (read-only), managed by usejarvis."
                  : "Connect Gmail and Google Calendar (read-only), managed by usejarvis."
                : g?.can_send
                  ? "Gmail (read and send) and Google Calendar (read-only). Restart-required after connect/disconnect."
                  : "Connect Gmail and Google Calendar (read-only by default). Restart-required after connect/disconnect."}
            </div>
          </div>
          {g && (
            <span
              className={
                "v2-set__chip " +
                (g.status === "connected"
                  ? "v2-set__chip--ok"
                  : g.status === "credentials_saved" || g.status === "reconnect_required"
                    ? "v2-set__chip--warn"
                    : "")
              }
            >
              {g.status.replace(/_/g, " ")}
            </span>
          )}
        </div>

        {!g ? (
          <div className="v2-set__empty">Loading Google status…</div>
        ) : g.managed ? (
          /* HOSTED. The credentials form and this daemon's own OAuth flow do not
             belong here: the account is connected through the control plane,
             which owns the one redirect URI Google knows about. Connecting needs
             a signed-in session this UI does not have (it authenticates to the
             daemon with a device token, not the account), so the button hands
             off to the account page — which then opens the system browser,
             because Google refuses OAuth inside an embedded webview. */
          <>
            {g.is_authenticated ? (
              <>
                <p className="v2-set__hint">
                  {g.can_send
                    ? "Gmail and Google Calendar are connected. Jarvis can send mail from this account, and every send waits for your approval on a card first. Calendar is read-only: Jarvis does not edit events."
                    : "Gmail and Google Calendar are connected, read-only. Jarvis does not send mail or edit events from this account."}
                </p>
                {!g.can_send && (
                  <p className="v2-set__hint">
                    {g.send_available
                      ? "Sending mail from this account is a separate choice on your account page."
                      : "Sending mail from this account is not turned on for this instance."}
                  </p>
                )}
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <a
                    className="v2-set__btn"
                    href={g.connect_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Manage in your account
                  </a>
                </div>
              </>
            ) : (
              <>
                <p className="v2-set__hint">
                  {g.status === "reconnect_required"
                    ? (g.reconnect_reason ??
                      "Google access is no longer valid — connect your account again.")
                    : g.send_available
                      ? "Connect your Google account to let Jarvis read your Gmail and Calendar. Sending mail is a separate choice on your account page, and every send waits for your approval first. You can disconnect at any time."
                      : "Connect your Google account to let Jarvis read your Gmail and Calendar. Nothing is sent or changed — access is read-only, and you can disconnect at any time."}
                </p>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <a
                    className="v2-set__btn v2-set__btn--primary"
                    href={g.connect_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Connect Google account
                  </a>
                </div>
              </>
            )}
          </>
        ) : g.status === "not_configured" && phase !== "saving" ? (
          <>
            <p className="v2-set__hint">
              You'll need OAuth2 credentials from Google Cloud Console &gt; APIs &amp; Credentials.
            </p>
            <div className="v2-set__section" style={{ marginBottom: 0 }}>
              <div className="v2-set__field-label">Setup steps</div>
              <ol style={{ margin: 0, paddingLeft: 20, color: "var(--ink-2)", fontSize: "var(--text-xs)", lineHeight: 1.7 }}>
                <li>
                  Enable <strong>Gmail API</strong> and <strong>Google Calendar API</strong> in your Google Cloud project
                </li>
                <li>
                  Create an <strong>OAuth 2.0 Client ID</strong> (type: Web application)
                </li>
                <li>
                  Add this Authorized redirect URI:
                  <code className="v2-set__code v2-set__code--block">
                    {googleRedirectUri}
                  </code>
                </li>
                <li>Paste the Client ID and Client Secret below</li>
              </ol>
            </div>
            {originWarnings.map((warning) => (
              <p className="v2-set__hint v2-set__hint--warn" key={warning}>{warning}</p>
            ))}
            <div className="v2-set__field">
              <label className="v2-set__field-label" htmlFor={clientIdInput}>Client ID</label>
              <input
                className="v2-set__input"
                id={clientIdInput}
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label" htmlFor={clientSecretInput}>Client secret</label>
              <input
                className="v2-set__input"
                id={clientSecretInput}
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={handleSaveCredentials}
              >
                Save credentials
              </button>
            </div>
          </>
        ) : phase === "saving" ? (
          <div className="v2-set__empty">Saving…</div>
        ) : g.status === "credentials_saved" && phase === "idle" ? (
          <>
            <p className="v2-set__hint">Credentials saved. Connect a Google account to authorize.</p>
            <div className="v2-set__field">
              <div className="v2-set__field-label">Authorized redirect URI</div>
              <code className="v2-set__code v2-set__code--block">{googleRedirectUri}</code>
            </div>
            {originWarnings.map((warning) => (
              <p className="v2-set__hint v2-set__hint--warn" key={warning}>{warning}</p>
            ))}
            <div className="v2-set__field">
              <label htmlFor={sendInput} style={{ display: "flex", gap: "var(--s-2)", alignItems: "flex-start" }}>
                <input
                  id={sendInput}
                  type="checkbox"
                  checked={allowSend}
                  onChange={(e) => setAllowSend(e.target.checked)}
                />
                <span>Also allow sending mail</span>
              </label>
              <p className="v2-set__hint">{GMAIL_SEND_GRANT}</p>
            </div>
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={() => void handleConnect(allowSend)}
              >
                Connect Google account
              </button>
            </div>
            <p className="v2-set__hint">Opens the consent page in a new window.</p>
          </>
        ) : phase === "authenticating" ? (
          <div className="v2-set__empty">Waiting for Google authorization in the popup…</div>
        ) : (
          /* connected */
          <>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Gmail</span>
              <span className="v2-set__row-value">
                <span className="v2-set__dot v2-set__dot--ok" /> {g.can_send ? "read and send (each send asks you first)" : "read-only"}
              </span>
            </div>
            <div className="v2-set__row">
              <span className="v2-set__row-label">Google Calendar</span>
              <span className="v2-set__row-value">
                <span className="v2-set__dot v2-set__dot--ok" /> read-only
              </span>
            </div>
            {g.token_expiry && (
              <div className="v2-set__row">
                <span className="v2-set__row-label">Token expires</span>
                <span className="v2-set__row-value">
                  {new Date(g.token_expiry).toLocaleString()}
                </span>
              </div>
            )}
            {g.scopes.length > 0 && (
              <div className="v2-set__field">
                <label className="v2-set__field-label">Scopes</label>
                <div className="v2-set__chip-row">
                  {g.scopes.map((s) => (
                    <span key={s} className="v2-set__chip" title={s}>
                      {s.replace(/^https?:\/\/[^/]+\//, "")}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <p className="v2-set__hint">
              {g.can_send
                ? "Jarvis can send mail from this account. Every send waits for your approval on a card before it goes out."
                : "Read-only: Jarvis does not send mail or edit events from this account."}
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)", flexWrap: "wrap" }}>
              {g.can_send ? (
                <button type="button" className="v2-set__btn" onClick={() => void handleReadOnly()}>
                  Make read-only
                </button>
              ) : (
                <button type="button" className="v2-set__btn" onClick={() => void handleAllowSend()}>
                  Allow sending mail
                </button>
              )}
              <button
                type="button"
                className="v2-set__btn v2-set__btn--danger"
                onClick={handleDisconnect}
              >
                Disconnect Google
              </button>
            </div>
          </>
        )}
      </section>
      {/* Their own blocks, independent of how Google is connected; each renders
          nothing unless hosting offers it or it is already connected. */}
      <ClickUpConnection optional />
      <GitHubConnection optional />
      <DropboxConnection optional />
      <TrelloConnection optional />
      <LinearConnection optional />
      <WrikeConnection optional />
      <MondayConnection optional />
      <TypeformConnection optional />
      <AirtableConnection optional />
      <TodoistConnection optional /><AsanaConnection optional /><PipedriveConnection optional /><ZoomConnection optional /><HelpScoutConnection optional /><GitLabConnection optional />
      <FigmaConnection optional />
      <WebflowConnection optional />
      <SlackConnection optional />
      <IntercomConnection optional />
      <CalendlyConnection optional />
      <NotionConnection optional />
    </div>
  );
}
