import React from "react";
import { SafeMarkdown } from "../../../components/SafeMarkdown";

/** Reply text is untrusted. Main's SafeMarkdown (#1065) owns the policy: no raw HTML,
 * no image loads, restricted URL schemes, in-result footnote navigation. Brief only
 * adds keyboard-scrollable code blocks and tables. */
export function ReplyMarkdown({ text }: { text: string }) {
  return <div className="brief-reply-prose"><SafeMarkdown text={text}
    components={{
      pre: ({ node: _node, children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>,
      table: ({ node: _node, children }) => <div className="brief-reply-table" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
    }}/></div>;
}
