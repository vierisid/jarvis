import React, { useEffect, useRef, useState } from "react";
import { api, useApiData } from "../../hooks/useApi";

type AutostartStatus = {
  platform: string;
  manager: string;
  installed: boolean;
  keepalive_supported: boolean;
  restart_supported: boolean;
};

export function ServicePanel() {
  const { data, loading, error, refetch } = useApiData<AutostartStatus>("/api/system/autostart", []);
  const [phase, setPhase] = useState<"idle" | "restarting">("idle");
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  const restartService = async () => {
    setPhase("restarting");
    setMessage(null);
    try {
      const res = await api<{ ok: boolean; message: string }>("/api/system/autostart/restart", {
        method: "POST",
      });
      setMessage({ text: res.message, type: "success" });
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = setTimeout(async () => {
        await refetch();
        setPhase("idle");
        refreshTimerRef.current = null;
      }, 2500);
    } catch (err) {
      setMessage({
        text: err instanceof Error ? err.message : "Failed to restart service.",
        type: "error",
      });
      setPhase("idle");
    }
  };

  if (loading) {
    return <div style={cardStyle}><span style={mutedTextStyle}>Loading service controls...</span></div>;
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
    return <div style={cardStyle}><span style={mutedTextStyle}>Service controls unavailable.</span></div>;
  }

  return (
    <div style={cardStyle}>
      <div style={headerRowStyle}>
        <div>
          <h3 style={headerStyle}>24/7 Service</h3>
          <div style={subtleStyle}>
            Manage the keepalive service that keeps JARVIS running after the terminal closes.
          </div>
        </div>
        <span
          style={{
            ...statusBadgeStyle,
            color: data.installed ? "var(--j-success)" : "var(--j-text-muted)",
            borderColor: data.installed ? "rgba(52, 211, 153, 0.25)" : "var(--j-border)",
            background: data.installed ? "rgba(52, 211, 153, 0.10)" : "rgba(255,255,255,0.03)",
          }}
        >
          {data.installed ? "Installed" : "Not Installed"}
        </span>
      </div>

      <div style={infoGridStyle}>
        <InfoRow label="Manager" value={data.manager} />
        <InfoRow label="Platform" value={data.platform} />
        <InfoRow
          label="Restart"
          value={data.restart_supported ? "Available" : data.keepalive_supported ? "Install keepalive first" : "Not supported"}
        />
      </div>

      {message && (
        <div style={{
          ...messageStyle,
          color: message.type === "success" ? "var(--j-success)" : "var(--j-error)",
          borderColor: message.type === "success" ? "rgba(52, 211, 153, 0.22)" : "rgba(248, 113, 113, 0.22)",
          background: message.type === "success" ? "rgba(52, 211, 153, 0.08)" : "rgba(248, 113, 113, 0.08)",
        }}>
          {message.text}
        </div>
      )}

      {error && !message && (
        <div style={{ ...messageStyle, color: "var(--j-error)", borderColor: "rgba(248, 113, 113, 0.22)", background: "rgba(248, 113, 113, 0.08)" }}>
          {error}
        </div>
      )}

      <div style={actionsStyle}>
        <button
          type="button"
          onClick={restartService}
          disabled={!data.restart_supported || phase === "restarting"}
          style={{
            ...buttonStyle,
            opacity: !data.restart_supported || phase === "restarting" ? 0.55 : 1,
            cursor: !data.restart_supported || phase === "restarting" ? "not-allowed" : "pointer",
          }}
        >
          {phase === "restarting" ? "Restarting..." : "Restart 24/7 JARVIS"}
        </button>
        <button type="button" onClick={refetch} style={secondaryButtonStyle}>
          Refresh Status
        </button>
      </div>
    </div>
  );
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
  marginBottom: "16px",
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
  textTransform: "capitalize",
};

const messageStyle: React.CSSProperties = {
  fontSize: "12px",
  border: "1px solid transparent",
  borderRadius: "8px",
  padding: "10px 12px",
  marginBottom: "16px",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  gap: "10px",
  flexWrap: "wrap",
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
  cursor: "pointer",
};
