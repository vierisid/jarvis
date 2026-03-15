import React, { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";
import { DocumentCard } from "./DocumentCard";

type Props = {
  content: string;
};

const DOC_MARKER_RE = /<!-- jarvis:document id="([^"]+)" title="([^"]+)" format="([^"]+)" size="([^"]+)" -->/g;

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      style={{
        position: "absolute",
        top: "8px",
        right: "8px",
        padding: "3px 8px",
        fontSize: "10px",
        fontFamily: "'JetBrains Mono', monospace",
        background: copied ? "rgba(52, 211, 153, 0.15)" : "rgba(255,255,255,0.06)",
        border: `1px solid ${copied ? "rgba(52, 211, 153, 0.3)" : "rgba(255,255,255,0.08)"}`,
        borderRadius: "4px",
        color: copied ? "var(--j-success)" : "var(--j-text-dim)",
        cursor: "pointer",
        transition: "all 150ms",
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

const components: Components = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const isBlock = match || (typeof children === "string" && children.includes("\n"));

    if (isBlock) {
      const text = String(children).replace(/\n$/, "");
      return (
        <div style={{ position: "relative" }}>
          {match && (
            <span
              style={{
                position: "absolute",
                top: "8px",
                left: "12px",
                fontSize: "10px",
                fontFamily: "'JetBrains Mono', monospace",
                color: "var(--j-text-muted)",
                letterSpacing: "0.04em",
              }}
            >
              {match[1]}
            </span>
          )}
          <CopyButton text={text} />
          <pre
            style={{
              background: "rgba(0, 0, 0, 0.35)",
              border: "1px solid var(--j-border)",
              borderRadius: "12px",
              padding: match ? "28px 14px 14px" : "14px",
              overflowX: "auto",
              fontSize: "12px",
              lineHeight: "1.65",
            }}
          >
            <code className={className} {...props}>
              {children}
            </code>
          </pre>
        </div>
      );
    }

    // Inline code — violet styling (CSS overrides in chat.css handle .chat-page context)
    return (
      <code
        style={{
          background: "rgba(139, 92, 246, 0.08)",
          border: "1px solid rgba(139, 92, 246, 0.10)",
          borderRadius: "5px",
          padding: "2px 7px",
          fontSize: "0.85em",
          fontFamily: "'JetBrains Mono', monospace",
          color: "var(--j-accent2)",
        }}
        {...props}
      >
        {children}
      </code>
    );
  },

  a({ href, children, ...props }) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--j-accent2)",
          textDecoration: "none",
          borderBottom: "1px solid rgba(139,92,246,0.3)",
          transition: "border-color 150ms",
        }}
        {...props}
      >
        {children}
      </a>
    );
  },

  table({ children, ...props }) {
    return (
      <div style={{ overflowX: "auto", margin: "12px 0" }}>
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: "12px",
            border: "1px solid var(--j-border)",
            borderRadius: "8px",
            overflow: "hidden",
          }}
          {...props}
        >
          {children}
        </table>
      </div>
    );
  },

  th({ children, ...props }) {
    return (
      <th
        style={{
          background: "rgba(139, 92, 246, 0.04)",
          borderBottom: "1px solid var(--j-border-bright)",
          padding: "8px 12px",
          textAlign: "left",
          fontSize: "10px",
          fontWeight: 600,
          color: "var(--j-text-dim)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
        {...props}
      >
        {children}
      </th>
    );
  },

  td({ children, ...props }) {
    return (
      <td
        style={{
          borderBottom: "1px solid var(--j-border)",
          padding: "7px 12px",
          color: "var(--j-text-dim)",
        }}
        {...props}
      >
        {children}
      </td>
    );
  },

  blockquote({ children, ...props }) {
    return (
      <blockquote
        style={{
          borderLeft: "2px solid var(--j-accent)",
          margin: "12px 0",
          padding: "10px 16px",
          color: "var(--j-text-dim)",
          background: "rgba(139, 92, 246, 0.06)",
          borderRadius: "0 10px 10px 0",
          fontSize: "13px",
          lineHeight: "1.65",
        }}
        {...props}
      >
        {children}
      </blockquote>
    );
  },

  img({ src, alt, ...props }) {
    return (
      <img
        src={src}
        alt={alt}
        style={{
          maxWidth: "100%",
          borderRadius: "8px",
          border: "1px solid var(--j-border)",
          margin: "4px 0",
        }}
        {...props}
      />
    );
  },

  hr() {
    return (
      <hr
        style={{
          border: "none",
          borderTop: "1px solid var(--j-border)",
          margin: "12px 0",
        }}
      />
    );
  },

  input({ type, checked, ...props }) {
    if (type === "checkbox") {
      return (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          style={{
            marginRight: "6px",
            accentColor: "var(--j-accent)",
          }}
          {...props}
        />
      );
    }
    return <input type={type} {...props} />;
  },
};

export function MarkdownContent({ content }: Props) {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(DOC_MARKER_RE.source, 'g');

  while ((match = re.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index).trim();
      if (text) {
        parts.push(
          <ReactMarkdown
            key={`md-${lastIndex}`}
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeHighlight]}
            components={components}
          >
            {text}
          </ReactMarkdown>
        );
      }
    }
    parts.push(
      <DocumentCard
        key={`doc-${match[1]}`}
        id={match[1]!}
        title={match[2]!}
        format={match[3]!}
        size={match[4]!}
      />
    );
    lastIndex = match.index + match[0].length;
  }

  const remaining = content.slice(lastIndex).trim();
  if (remaining) {
    parts.push(
      <ReactMarkdown
        key={`md-${lastIndex}`}
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {remaining}
      </ReactMarkdown>
    );
  }

  return <div className="markdown-content">{parts}</div>;
}
