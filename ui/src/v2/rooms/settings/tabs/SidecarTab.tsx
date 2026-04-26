import React, { useState } from "react";
import type { SettingsHook } from "../useSettingsData";
// Embed the legacy config editor — it's a 200+ LOC YAML+form editor with
// its own modal chrome; rebuilding pixel-perfect adds a lot of LOC for a
// power-user surface. The retheme cascade on .v2-set__legacy-embed
// remaps --j-* → v2 tokens.
import { SidecarConfigEditor } from "../../../../components/settings/SidecarConfigEditor";

export function SidecarTab({
  data,
  onToast,
}: {
  data: SettingsHook;
  onToast: (text: string, tone?: "ok" | "warn") => void;
}) {
  const { sidecars } = data;
  const [enrollName, setEnrollName] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [enrollResult, setEnrollResult] = useState<{ token: string; name: string } | null>(null);
  const [configTarget, setConfigTarget] = useState<{ id: string; name: string } | null>(null);

  const handleEnroll = async () => {
    const name = enrollName.trim();
    if (!name) return;
    setEnrolling(true);
    const r = await data.enrollSidecar(name);
    if (r.ok) {
      setEnrollResult({ token: r.token, name: r.name });
      setEnrollName("");
      onToast(`Enrolled "${r.name}". Copy the token now — it's shown only once.`, "ok");
    } else {
      onToast(r.message, "warn");
    }
    setEnrolling(false);
  };

  const handleRevoke = async (id: string, name: string) => {
    if (!confirm(`Revoke sidecar "${name}"? It will lose access to Jarvis.`)) return;
    const r = await data.revokeSidecar(id);
    onToast(r.message, r.ok ? "ok" : "warn");
  };

  const copyToken = () => {
    if (!enrollResult) return;
    navigator.clipboard.writeText(enrollResult.token).then(
      () => onToast("Token copied to clipboard.", "ok"),
      () => onToast("Copy failed — select manually.", "warn"),
    );
  };

  return (
    <div>
      {/* Enroll new sidecar */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Enroll a new sidecar</h3>
            <div className="v2-set__section-sub">
              Run the resulting token on the target machine to extend Jarvis there.
            </div>
          </div>
        </div>
        <div className="v2-set__field">
          <label className="v2-set__field-label">Sidecar name</label>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <input
              className="v2-set__input"
              placeholder="e.g. work-laptop"
              value={enrollName}
              onChange={(e) => setEnrollName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleEnroll()}
            />
            <button
              type="button"
              className="v2-set__btn v2-set__btn--primary"
              onClick={handleEnroll}
              disabled={enrolling || !enrollName.trim()}
            >
              {enrolling ? "Enrolling…" : "Enroll"}
            </button>
          </div>
        </div>

        {enrollResult && (
          <div className="v2-set__token-box">
            <div className="v2-set__token-label">
              Token for "{enrollResult.name}" — copy now, this is shown only once
            </div>
            <code className="v2-set__code v2-set__code--block">
              jarvis-sidecar --token {enrollResult.token}
            </code>
            <div style={{ display: "flex", gap: "var(--s-2)", justifyContent: "flex-end" }}>
              <button type="button" className="v2-set__btn" onClick={copyToken}>
                Copy token
              </button>
              <button
                type="button"
                className="v2-set__btn"
                onClick={() => setEnrollResult(null)}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Enrolled sidecars list */}
      <section className="v2-set__section">
        <div className="v2-set__section-head">
          <div>
            <h3 className="v2-set__section-title">Enrolled sidecars</h3>
            <div className="v2-set__section-sub">
              {sidecars.length === 0
                ? "No sidecars enrolled yet."
                : `${sidecars.length} sidecar${sidecars.length === 1 ? "" : "s"} · ${data.stats.sidecarsConnected} connected`}
            </div>
          </div>
        </div>

        {sidecars.length === 0 ? (
          <div className="v2-set__empty">Enroll one above to get started.</div>
        ) : (
          <ul className="v2-set__sidecar-list" role="list">
            {sidecars.map((sc) => (
              <li key={sc.id} className="v2-set__sidecar">
                <span
                  className={
                    "v2-set__dot " + (sc.connected ? "v2-set__dot--ok" : "")
                  }
                />
                <span className="v2-set__sidecar-name">{sc.name}</span>
                <div className="v2-set__sidecar-meta">
                  {sc.hostname && <span>{sc.hostname}</span>}
                  {sc.os && sc.platform && <span>· {sc.os}/{sc.platform}</span>}
                  {sc.capabilities && sc.capabilities.length > 0 && (
                    <span>· {sc.capabilities.join(", ")}</span>
                  )}
                  {sc.unavailable_capabilities && sc.unavailable_capabilities.length > 0 && (
                    <span style={{ color: "var(--warn)" }}>
                      ·{" "}
                      {sc.unavailable_capabilities.map((u, i) => (
                        <span key={u.name} title={u.reason}>
                          {i > 0 ? ", " : ""}
                          ⚠ {u.name}
                        </span>
                      ))}
                    </span>
                  )}
                  {sc.last_seen_at && (
                    <span>· last seen {new Date(sc.last_seen_at).toLocaleString()}</span>
                  )}
                </div>
                <div className="v2-set__sidecar-actions">
                  {sc.connected && (
                    <button
                      type="button"
                      className="v2-set__btn"
                      onClick={() => setConfigTarget({ id: sc.id, name: sc.name })}
                    >
                      Configure
                    </button>
                  )}
                  <button
                    type="button"
                    className="v2-set__btn v2-set__btn--danger"
                    onClick={() => handleRevoke(sc.id, sc.name)}
                  >
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Legacy config editor modal — rethemed via cascade */}
      {configTarget && (
        <div className="v2-set__legacy-embed">
          <SidecarConfigEditor
            sidecarId={configTarget.id}
            sidecarName={configTarget.name}
            unavailableCapabilities={
              sidecars.find((s) => s.id === configTarget.id)?.unavailable_capabilities ?? []
            }
            onClose={() => setConfigTarget(null)}
          />
        </div>
      )}
    </div>
  );
}
