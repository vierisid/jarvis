import React, { useState } from "react";

type Props = {
  id: string;
  title: string;
  format: string;
  size: string;
};

const FORMAT_ICONS: Record<string, string> = {
  markdown: "\u2193",
  plain: "\u2193",
  html: "\u2193",
  json: "\u2193",
  csv: "\u2193",
  code: "\u2193",
};

const FORMAT_LABELS: Record<string, string> = {
  markdown: "Markdown",
  plain: "Plain Text",
  html: "HTML",
  json: "JSON",
  csv: "CSV",
  code: "Code",
};

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

export function DocumentCard({ id, title, format, size }: Props) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const resp = await fetch(`/api/documents/${id}/download`);
      if (!resp.ok) throw new Error("Download failed");
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const disposition = resp.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="(.+)"/);
      a.download = match?.[1] ?? `${title}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Document download error:", err);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 16px",
        background: "rgba(0, 212, 255, 0.06)",
        border: "1px solid rgba(0, 212, 255, 0.2)",
        borderRadius: "8px",
        margin: "8px 0",
      }}
    >
      {/* Document icon */}
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: "8px",
          background: "rgba(0, 212, 255, 0.12)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "16px",
          color: "var(--j-accent)",
          flexShrink: 0,
        }}
      >
        {"\u25A0"}
      </div>

      {/* Info */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: "13px",
            fontWeight: 600,
            color: "var(--j-text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: "11px",
            color: "var(--j-text-muted)",
            marginTop: "2px",
          }}
        >
          {FORMAT_LABELS[format] || format} &middot; {formatSize(parseInt(size, 10) || 0)}
        </div>
      </div>

      {/* Download button */}
      <button
        onClick={handleDownload}
        disabled={downloading}
        style={{
          padding: "6px 14px",
          fontSize: "12px",
          fontWeight: 500,
          background: downloading
            ? "rgba(0, 212, 255, 0.08)"
            : "rgba(0, 212, 255, 0.15)",
          border: "1px solid rgba(0, 212, 255, 0.3)",
          borderRadius: "6px",
          color: "var(--j-accent)",
          cursor: downloading ? "default" : "pointer",
          transition: "all 0.15s ease",
          whiteSpace: "nowrap",
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          if (!downloading) {
            e.currentTarget.style.background = "rgba(0, 212, 255, 0.25)";
          }
        }}
        onMouseLeave={(e) => {
          if (!downloading) {
            e.currentTarget.style.background = "rgba(0, 212, 255, 0.15)";
          }
        }}
      >
        {downloading ? "Downloading..." : "Download"}
      </button>
    </div>
  );
}
