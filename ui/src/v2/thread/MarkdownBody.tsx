import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./MarkdownBody.css";

/**
 * MarkdownBody — renders an assistant/result message as markdown.
 * Scoped under `.v2-md` so prose styles inherit the thread bubble's
 * font, size, and line-height without fighting them. GFM enabled for
 * tables, strikethrough, task lists, autolinks.
 */
export function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="v2-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Strip the default paragraph wrapper on single-line messages;
          // users rarely care and the extra margin looks loose in short replies.
          p: ({ node, ...props }) => <p className="v2-md__p" {...props} />,
          code: ({ node, className, children, ...props }) => {
            const isBlock = /language-/.test(className ?? "");
            return isBlock ? (
              <code className={`v2-md__code-block ${className ?? ""}`} {...props}>
                {children}
              </code>
            ) : (
              <code className="v2-md__code-inline" {...props}>
                {children}
              </code>
            );
          },
          a: ({ node, ...props }) => <a className="v2-md__link" {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
