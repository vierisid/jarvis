import React, { useEffect, useRef } from "react";
import { useApiData, api } from "../../hooks/useApi";

type SuggestionRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  dismissed: number;
  acted_on: number;
  created_at: number;
};

export function SuggestionPanel() {
  const { data, loading, refetch } = useApiData<SuggestionRow[]>("/api/awareness/suggestions?limit=10", []);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll every 5 seconds for new suggestions
  useEffect(() => {
    intervalRef.current = setInterval(refetch, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refetch]);

  const dismiss = async (id: string) => {
    await api(`/api/awareness/suggestions/${id}/dismiss`, { method: "PATCH" });
    refetch();
  };

  const actOn = async (id: string) => {
    await api(`/api/awareness/suggestions/${id}/act`, { method: "PATCH" });
    refetch();
  };

  const active = (data ?? []).filter(s => !s.dismissed && !s.acted_on);
  const past = (data ?? []).filter(s => s.dismissed || s.acted_on);

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>Suggestions</div>

      {loading && (
        <div style={{ padding: "16px", color: "var(--j-text-muted)", fontSize: "13px" }}>Loading...</div>
      )}

      {!loading && active.length === 0 && (
        <div style={{ padding: "16px", color: "var(--j-text-muted)", fontSize: "13px" }}>
          No active suggestions
        </div>
      )}

      {active.map(s => (
        <div key={s.id} style={suggestionStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
            <span style={{ ...typeBadge, background: typeColors[s.type] || "var(--j-text-muted)" }}>
              {s.type}
            </span>
            <span style={{ fontSize: "13px", fontWeight: 500, color: "var(--j-text)" }}>{s.title}</span>
          </div>
          <div style={{ fontSize: "12px", color: "var(--j-text-dim)", marginBottom: "8px" }}>{s.body}</div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button onClick={() => actOn(s.id)} style={actionBtn}>Help me</button>
            <button onClick={() => dismiss(s.id)} style={dismissBtn}>Dismiss</button>
          </div>
        </div>
      ))}

      {past.length > 0 && (
        <>
          <div style={{ ...headerStyle, fontSize: "12px", color: "var(--j-text-muted)", borderTop: "1px solid var(--j-border)" }}>
            Past ({past.length})
          </div>
          {past.slice(0, 5).map(s => (
            <div key={s.id} style={{ ...suggestionStyle, opacity: 0.6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <span style={{ ...typeBadge, background: "var(--j-text-muted)" }}>{s.type}</span>
                <span style={{ fontSize: "12px", color: "var(--j-text-dim)" }}>{s.title}</span>
                <span style={{ fontSize: "11px", color: "var(--j-text-muted)", marginLeft: "auto" }}>
                  {s.acted_on ? "Acted" : "Dismissed"}
                </span>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

const typeColors: Record<string, string> = {
  error: "#ff4444",
  stuck: "#ffaa00",
  automation: "#00ccff",
  knowledge: "#8855ff",
  schedule: "#44bb44",
  break: "#ff8800",
  general: "#6688aa",
};

const cardStyle: React.CSSProperties = {
  background: "var(--j-surface)",
  border: "1px solid var(--j-border)",
  borderRadius: "8px",
  overflow: "hidden",
};

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: "14px",
  fontWeight: 600,
  color: "var(--j-text)",
  borderBottom: "1px solid var(--j-border)",
};

const suggestionStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid var(--j-border)",
};

const typeBadge: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: "8px",
  fontSize: "10px",
  fontWeight: 600,
  color: "#fff",
  textTransform: "uppercase",
};

const actionBtn: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: "4px",
  border: "1px solid var(--j-accent)",
  background: "rgba(0, 212, 255, 0.1)",
  color: "var(--j-accent)",
  fontSize: "12px",
  cursor: "pointer",
};

const dismissBtn: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: "4px",
  border: "1px solid var(--j-border)",
  background: "transparent",
  color: "var(--j-text-muted)",
  fontSize: "12px",
  cursor: "pointer",
};
