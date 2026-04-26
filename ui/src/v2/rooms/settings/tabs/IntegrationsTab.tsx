import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsHook } from "../useSettingsData";

export function IntegrationsTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const g = data.google;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [phase, setPhase] = useState<"idle" | "saving" | "authenticating">("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Listen for the OAuth popup completion event
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.data === "google-auth-complete") {
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setPhase("idle");
        onToast("Connected. Restart Jarvis to activate Gmail and Calendar observers.", "ok");
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

  const handleConnect = async () => {
    const r = await data.initGoogleAuth();
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
            "Connected. Restart Jarvis to activate Gmail and Calendar observers.",
            "ok",
          );
          data.refresh();
        }
      } catch {
        /* poll error — ignore */
      }
    }, 3000);
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect Google? You'll need to re-authorize to reconnect.")) return;
    const r = await data.disconnectGoogle();
    onToast(r.message, r.ok ? "ok" : "warn");
  };

  return (
    <div>
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Google</h3>
            <div className="v2-set__section-sub">
              Connect Gmail and Google Calendar (read-only). Restart-required after connect/disconnect.
            </div>
          </div>
          {g && (
            <span
              className={
                "v2-set__chip " +
                (g.status === "connected"
                  ? "v2-set__chip--ok"
                  : g.status === "credentials_saved"
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
                    http://localhost:3142/api/auth/google/callback
                  </code>
                </li>
                <li>Paste the Client ID and Client Secret below</li>
              </ol>
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Client ID</label>
              <input
                className="v2-set__input"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              />
            </div>
            <div className="v2-set__field">
              <label className="v2-set__field-label">Client secret</label>
              <input
                className="v2-set__input"
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
            <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="v2-set__btn v2-set__btn--primary"
                onClick={handleConnect}
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
                <span className="v2-set__dot v2-set__dot--ok" /> read-only
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
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
    </div>
  );
}
