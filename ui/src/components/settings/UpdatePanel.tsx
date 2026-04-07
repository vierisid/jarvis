import React, { useEffect, useRef, useState } from "react";
import { api, useApiData } from "../../hooks/useApi";
import type { UpdateInfo } from "../../types/update";

export function UpdatePanel() {
  const { data, loading, error, refetch } = useApiData<UpdateInfo>("/api/system/update", []);
  const [phase, setPhase] = useState<"idle" | "checking" | "updating">("idle");
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const refetchTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (refetchTimerRef.current !== null) {
      window.clearTimeout(refetchTimerRef.current);
    }
  }, []);

  const checkForUpdates = async () => {
    setPhase("checking");
    setMessage(null);
    try {
      const status = await api<UpdateInfo>("/api/system/update?refresh=1");
      setMessage({
        text: status.has_update
          ? `Update available: ${status.latest_version}.`
          : `You are already on the latest version (${status.current_version}).`,
        type: "success",
      });
      refetch();
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to check for updates.",
        type: "error",
      });
    } finally {
      setPhase("idle");
    }
  };

  const startUpdate = async () => {
    if (!data?.has_update) {
      setMessage({
        text: `You're already up to date! Running on v${data?.current_version}. Check back later for new releases.`,
        type: "success",
      });
      return;
    }

    setPhase("updating");
    setMessage(null);
    try {
      const res = await api<{ ok: boolean; message: string }>("/api/system/update", {
        method: "POST",
      });
      setMessage({ text: res.message, type: "success" });
      if (refetchTimerRef.current !== null) {
        window.clearTimeout(refetchTimerRef.current);
      }
      refetchTimerRef.current = window.setTimeout(() => {
        refetchTimerRef.current = null;
        refetch();
      }, 1500);
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to start update.",
        type: "error",
      });
    } finally {
      setPhase("idle");
    }
  };

  if (loading) {
    return <div style={cardStyle}><span style={mutedTextStyle}>Loading update status...</span></div>;
  }

  if (error && !data) {
    return (
      <div style={cardStyle}>
        <div style={{ ...messageStyle, color: "var(--j-error)", borderColor: "rgba(248, 113, 113, 0.22)", background: "rgba(248, 113, 113, 0.08)", marginBottom: 0 }}>
          {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return <div style={cardStyle}><span style={mutedTextStyle}>Update controls unavailable.</span></div>;
  }

  const isBusy = data.update_status === "queued" || data.update_status === "in_progress";

  return (
    <div style={cardStyle}>
      <div style={headerRowStyle}>
        <div>
          <h3 style={headerStyle}>Release Updates {data.current_version && `(v${data.current_version})`}</h3>
          <div style={subtleStyle}>
            Check the latest GitHub release and trigger the built-in `jarvis update` flow from the dashboard.
          </div>
        </div>
        <span
          style={{
            ...statusBadgeStyle,
            color: data.has_update ? "var(--j-accent)" : "var(--j-success)",
            borderColor: data.has_update ? "rgba(0, 212, 255, 0.28)" : "rgba(52, 211, 153, 0.25)",
            background: data.has_update ? "rgba(0, 212, 255, 0.10)" : "rgba(52, 211, 153, 0.10)",
          }}
        >
          {data.has_update ? "Update Available" : "Up To Date"}
        </span>
      </div>

      <div style={infoGridStyle}>
        <InfoRow label="Current version" value={data.current_version} />
        <InfoRow label="Latest release" value={data.latest_version ?? "Unknown"} />
        <InfoRow
          label="Published"
          value={data.latest_published_at ? new Date(data.latest_published_at).toLocaleString() : "Unknown"}
        />
        <InfoRow
          label="Last checked"
          value={data.last_checked_at ? new Date(data.last_checked_at).toLocaleString() : "Never"}
        />
        <InfoRow label="Update status" value={formatStatus(data.update_status)} />
      </div>

      {data.latest_url && (
        <a href={data.latest_url} target="_blank" rel="noreferrer" style={linkStyle}>
          Open release notes
        </a>
      )}

      {(message || data.update_message || data.check_error || error) && (
        <div style={{
          ...messageStyle,
          color: message?.type === "error" || data.check_error || error ? "var(--j-error)" : "var(--j-success)",
          borderColor: message?.type === "error" || data.check_error || error ? "rgba(248, 113, 113, 0.22)" : "rgba(52, 211, 153, 0.22)",
          background: message?.type === "error" || data.check_error || error ? "rgba(248, 113, 113, 0.08)" : "rgba(52, 211, 153, 0.08)",
        }}>
          {message?.text ?? data.check_error ?? error ?? data.update_message}
        </div>
      )}

      <div style={actionsStyle}>
        <button
          type="button"
          onClick={checkForUpdates}
          disabled={phase !== "idle"}
          style={{
            ...secondaryButtonStyle,
            opacity: phase !== "idle" ? 0.6 : 1,
            cursor: phase !== "idle" ? "not-allowed" : "pointer",
          }}
        >
          {phase === "checking" ? "Checking..." : "Search for Update"}
        </button>
        <button
          type="button"
          onClick={startUpdate}
          disabled={phase !== "idle" || isBusy || !data.has_update}
          style={{
            ...buttonStyle,
            opacity: phase !== "idle" || isBusy || !data.has_update ? 0.55 : 1,
            cursor: phase !== "idle" || isBusy || !data.has_update ? "not-allowed" : "pointer",
          }}
        >
          {isBusy || phase === "updating" ? "Updating..." : data.has_update ? "Update JARVIS" : "Already Up To Date"}
        </button>
      </div>
    </div>
  );
}

function formatStatus(status: string): string {
  if (status === "in_progress") return "In progress";
  if (status === "queued") return "Queued";
  if (status === "success") return "Completed";
  if (status === "error") return "Failed";
  return "Idle";
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={infoRowStyle}>
      <span style={infoLabelStyle}>{label}</span>
      <span style={infoValueStyle}>{value}</span>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: "20px",
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
};

const headerRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "flex-start",
  marginBottom: "16px",
  flexWrap: "wrap",
};

const headerStyle: React.CSSProperties = {
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--j-text)",
  margin: 0,
};

const subtleStyle: React.CSSProperties = {
  fontSize: "12px",
  lineHeight: 1.5,
  color: "var(--j-text-muted)",
  marginTop: "6px",
  maxWidth: "560px",
};

const mutedTextStyle: React.CSSProperties = {
  color: "var(--j-text-muted)",
  fontSize: "13px",
};

const statusBadgeStyle: React.CSSProperties = {
  padding: "5px 10px",
  borderRadius: "999px",
  border: "1px solid var(--j-border)",
  fontSize: "11px",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const infoGridStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  marginBottom: "14px",
};

const infoRowStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: "12px",
  fontSize: "13px",
};

const infoLabelStyle: React.CSSProperties = {
  color: "var(--j-text-dim)",
};

const infoValueStyle: React.CSSProperties = {
  color: "var(--j-text)",
};

const messageStyle: React.CSSProperties = {
  fontSize: "12px",
  border: "1px solid transparent",
  borderRadius: "8px",
  padding: "10px 12px",
  marginBottom: "16px",
  marginTop: "16px",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "10px",
  flexWrap: "wrap",
  marginTop: "16px",
};

const buttonStyle: React.CSSProperties = {
  border: "1px solid rgba(0, 212, 255, 0.28)",
  background: "rgba(0, 212, 255, 0.12)",
  color: "var(--j-accent)",
  borderRadius: "8px",
  padding: "10px 14px",
  fontSize: "13px",
  fontWeight: 600,
};

const secondaryButtonStyle: React.CSSProperties = {
  border: "1px solid var(--j-border)",
  background: "transparent",
  color: "var(--j-text-muted)",
  borderRadius: "8px",
  padding: "10px 14px",
  fontSize: "13px",
  fontWeight: 500,
};

const linkStyle: React.CSSProperties = {
  color: "var(--j-accent)",
  textDecoration: "none",
  fontSize: "12px",
  fontWeight: 500,
};
