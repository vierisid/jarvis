import React, { useState } from "react";

type Props = {
  id: string;
  title: string;
  format: string;
  size: string;
};

const FORMAT_LABELS: Record<string, string> = {
  markdown: "Markdown",
  plain: "Plain Text",
  html: "HTML",
  json: "JSON",
  csv: "CSV",
  code: "Code",
};

const FORMAT_ICONS: Record<string, string> = {
  markdown: "\u25A0",
  plain: "\u25A0",
  html: "\u25A0",
  json: "{ }",
  csv: "\u25A4",
  code: "\u27E8\u27E9",
};

function getIconClass(format: string): string {
  switch (format) {
    case "csv": return "chat-doc-icon chat-doc-icon-csv";
    case "json": return "chat-doc-icon chat-doc-icon-json";
    case "code": return "chat-doc-icon chat-doc-icon-code";
    case "markdown":
    case "plain":
    case "html":
      return "chat-doc-icon chat-doc-icon-md";
    default: return "chat-doc-icon chat-doc-icon-default";
  }
}

function formatSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`;
  return `${(chars / 1000).toFixed(1)}k chars`;
}

export function DocumentCard({ id, title, format, size }: Props) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
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
    <div className="chat-doc" onClick={handleDownload}>
      <div className={getIconClass(format)}>
        {FORMAT_ICONS[format] || "\u25A0"}
      </div>
      <div className="chat-doc-info">
        <div className="chat-doc-name">{title}</div>
        <div className="chat-doc-meta">
          {FORMAT_LABELS[format] || format} &middot; {formatSize(parseInt(size, 10) || 0)}
        </div>
      </div>
      <button
        className="chat-doc-dl"
        onClick={handleDownload}
        disabled={downloading}
        title={downloading ? "Downloading..." : "Download"}
      >
        {downloading ? "\u23F3" : "\u2193"}
      </button>
    </div>
  );
}
