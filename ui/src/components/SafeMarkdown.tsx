import React, { createContext, useContext, useId, useRef } from 'react';
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
  const root = useRef<HTMLDivElement>(null);
  const footnotePrefix = `user-content-${useId()}-`;
  function followFragment(event: React.MouseEvent<HTMLAnchorElement>) {
    // The app uses the URL hash for routing. A citation scrolls/focuses inside
    // this result; it must neither change rooms nor open a native browser tab.
    event.preventDefault();
    const fragment = event.currentTarget.getAttribute('href')!.slice(1);
    let decoded = fragment;
    try { decoded = decodeURIComponent(fragment); } catch { /* malformed escape: exact lookup only */ }
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[id]') ?? [])]
      .find(element => element.id === fragment || element.id === decoded);
    if (!target) return;
    if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
    target.scrollIntoView({ block: 'nearest' });
    target.focus({ preventScroll: true });
  }
  return <div ref={root} className="safe-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeMarkdownUrl}
    remarkRehypeOptions={{ clobberPrefix: footnotePrefix }}
    components={{
      ...components,
      a: ({ node, href, children, className, ...props }) => href
        ? <InsideLink.Provider value={true}><a {...props} className={['v2-md__link', className].filter(Boolean).join(' ')} href={href}
          target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer"
          onClick={href.startsWith('#') ? followFragment : undefined}>{children}</a></InsideLink.Provider>
        : <span>{children}</span>,
      img: ImageLink,
    }}>{text}</ReactMarkdown></div>;
}
