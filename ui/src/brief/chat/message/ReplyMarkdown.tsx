import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function safeReplyUrl(value: string) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}
/** No HTML execution, remote images, embeds or tool payload rendering. */
export function ReplyMarkdown({ text }: { text: string }) {
  return <div className="brief-reply-prose"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeReplyUrl}
    components={{
      a: ({ children, href }) => href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>,
      img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
      pre: ({ children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>,
      table: ({ children }) => <div className="brief-reply-table" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
    }}>{text}</ReactMarkdown></div>;
}
