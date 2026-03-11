import React, { useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Components } from "react-markdown";

type Props = {
  content: string;
};

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
        padding: "2px 8px",
        fontSize: "11px",
        background: copied ? "rgba(16, 185, 129, 0.2)" : "rgba(255,255,255,0.08)",
        border: `1px solid ${copied ? "rgba(16, 185, 129, 0.4)" : "rgba(255,255,255,0.12)"}`,
        borderRadius: "4px",
        color: copied ? "var(--j-success)" : "var(--j-text-dim)",
        cursor: "pointer",
        transition: "all 0.15s ease",
      }}
    >
      {copied ? "Copied!" : "Copy"}
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
                color: "var(--j-text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.5px",
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
              borderRadius: "6px",
              padding: match ? "28px 12px 12px" : "12px",
              overflowX: "auto",
              fontSize: "13px",
              lineHeight: "1.5",
            }}
          >
            <code className={className} {...props}>
              {children}
            </code>
          </pre>
        </div>
      );
    }

    // Inline code
    return (
      <code
        style={{
          background: "rgba(0, 212, 255, 0.1)",
          border: "1px solid rgba(0, 212, 255, 0.2)",
          borderRadius: "3px",
          padding: "1px 5px",
          fontSize: "0.9em",
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
          color: "var(--j-accent)",
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
          color: "var(--j-accent)",
          textDecoration: "none",
          borderBottom: "1px solid rgba(0, 212, 255, 0.3)",
          transition: "border-color 0.15s ease",
        }}
        {...props}
      >
        {children}
      </a>
    );
  },

  table({ children, ...props }) {
    return (
      <div style={{ overflowX: "auto", margin: "8px 0" }}>
        <table
          style={{
            borderCollapse: "collapse",
            width: "100%",
            fontSize: "13px",
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
          background: "rgba(0, 212, 255, 0.08)",
          border: "1px solid var(--j-border)",
          padding: "6px 10px",
          textAlign: "left",
          fontSize: "12px",
          fontWeight: 600,
          color: "var(--j-accent)",
          whiteSpace: "nowrap",
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
          border: "1px solid var(--j-border)",
          padding: "5px 10px",
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
          borderLeft: "3px solid var(--j-accent-dim)",
          margin: "8px 0",
          padding: "4px 12px",
          color: "var(--j-text-dim)",
          background: "rgba(0, 212, 255, 0.03)",
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
          borderRadius: "6px",
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
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
