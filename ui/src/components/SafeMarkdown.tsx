import React, { createContext, useContext } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const InsideLink = createContext(false);
function ImageLink({ src, alt }: { src?: string | Blob; alt?: string }) {
  const insideLink = useContext(InsideLink);
  return src && typeof src === 'string' && !insideLink
    ? <a className="v2-md__link" href={src} target="_blank" rel="noopener noreferrer">Image: {alt || 'open image'}</a>
    : <span>Image: {alt || 'unavailable'}</span>;
}

/** Result text can originate in a page, file or piece output. Rendering it must
 * not fetch an attacker-chosen image URL (including one carrying private text).
 * Links require a click; raw HTML and executable/custom URL schemes stay inert.
 */
export function safeMarkdownUrl(url: string): string {
  const safe = defaultUrlTransform(url);
  if (!safe || /[\s\u0000-\u001f\u007f\\]/.test(safe) || safe.startsWith('//')) return '';
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(safe)?.[1]?.toLowerCase();
  return !scheme || ['https', 'http', 'mailto'].includes(scheme) ? safe : '';
}

export function SafeMarkdown({ text, components }: { text: string; components?: Components }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeMarkdownUrl}
    components={{
      ...components,
      a: ({ href, children }) => href
        ? <InsideLink.Provider value={true}><a className="v2-md__link" href={href} target="_blank" rel="noopener noreferrer">{children}</a></InsideLink.Provider>
        : <span>{children}</span>,
      img: ImageLink,
    }}>{text}</ReactMarkdown>;
}
