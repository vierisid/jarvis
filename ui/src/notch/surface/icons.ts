/**
 * The drawings the notch carries inline. All of it is fixed markup written
 * here, never text that came from outside, which is why it may be set as HTML.
 */
import type { NotchApp } from '../../../../src/notch/protocol.ts';

/* Simplified stand-ins for app icons, as in the prototype. The real product would use each app's own icon. */
export const ICON: Record<NotchApp, string> = {
  desk: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#535B63"/><rect x="5" y="6.5" width="14" height="9.5" rx="1.6" fill="none" stroke="#fff" stroke-width="1.5"/><path d="M9 19h6" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x=".5" y=".5" width="23" height="23" rx="5" fill="#fff" stroke="rgba(0,0,0,.1)"/><path d="M5 8.4v7.9c0 .7.5 1.2 1.2 1.2h1.6v-6.3l4.2 3.1 4.2-3.1v6.3h1.6c.7 0 1.2-.5 1.2-1.2V8.4c0-1.3-1.5-2-2.5-1.2L12 10.6 7.5 7.2C6.5 6.4 5 7.1 5 8.4z" fill="#EA4335"/><path d="M5 8.4v7.9c0 .7.5 1.2 1.2 1.2h1.6v-6.3L5 9.1z" fill="#4285F4"/><path d="M19 8.4v7.9c0 .7-.5 1.2-1.2 1.2h-1.6v-6.3L19 9.1z" fill="#34A853"/></svg>',
  sheets: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#188038"/><path d="M7 7.2h10v9.6H7zM7 10.4h10M7 13.6h10M11 7.2v9.6" fill="none" stroke="#fff" stroke-width="1.4"/></svg>',
  pay: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#635BFF"/><path d="M11.3 9.6c0-.6.5-.8 1.2-.8 1.1 0 2.4.3 3.4.9V6.6c-1.1-.4-2.3-.6-3.4-.6-2.8 0-4.6 1.4-4.6 3.8 0 3.7 5.1 3.1 5.1 4.7 0 .7-.6.9-1.4.9-1.2 0-2.8-.5-4-1.2v3.1c1.4.6 2.7.8 4 .8 2.8 0 4.8-1.4 4.8-3.8 0-4-5.1-3.3-5.1-4.7z" fill="#fff"/></svg>',
  cal: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x=".5" y=".5" width="23" height="23" rx="5" fill="#fff" stroke="rgba(0,0,0,.1)"/><path d="M.5 5.5a5 5 0 0 1 5-5h13a5 5 0 0 1 5 5V8H.5z" fill="#1A73E8"/><text x="12" y="18.6" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="700" font-size="9.5" fill="#1A73E8">10</text></svg>',
  slack: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x=".5" y=".5" width="23" height="23" rx="5" fill="#fff" stroke="rgba(0,0,0,.1)"/><rect x="6" y="10" width="7" height="3" rx="1.5" fill="#36C5F0"/><rect x="10" y="6" width="3" height="7" rx="1.5" fill="#2EB67D"/><rect x="11" y="11" width="7" height="3" rx="1.5" fill="#ECB22E"/><rect x="11" y="11" width="3" height="7" rx="1.5" fill="#E01E5A"/></svg>',
  call: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#00897B"/><rect x="5" y="8" width="9.5" height="8" rx="1.8" fill="#fff"/><path d="m15.5 11 3.5-2.4v6.8L15.5 13z" fill="#fff"/></svg>',
  form: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x=".5" y=".5" width="23" height="23" rx="5" fill="#fff" stroke="rgba(0,0,0,.1)"/><circle cx="12" cy="12" r="6.6" fill="none" stroke="#535B63" stroke-width="1.5"/><path d="M5.4 12h13.2M12 5.4c2.2 2 2.2 11.2 0 13.2M12 5.4c-2.2 2-2.2 11.2 0 13.2" fill="none" stroke="#535B63" stroke-width="1.3"/></svg>',
  term: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#23272E"/><path d="M6.5 8.5 10 12l-3.5 3.5M12.5 16h5" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  dash: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#0B0D10"/><rect x="5.5" y="6" width="5" height="12" rx="1.3" fill="#D6FF5C"/><rect x="12.5" y="6" width="6" height="5" rx="1.3" fill="#EEF1F4"/><rect x="12.5" y="13" width="6" height="5" rx="1.3" fill="#7C838D"/></svg>',
  bank: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="5.5" fill="#22405F"/><path d="M5.5 10 12 6l6.5 4M7.2 11v5.5M10.4 11v5.5M13.6 11v5.5M16.8 11v5.5M5.5 18h13" fill="none" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

/** The chevron on a row that opens something, and the sheet-of-paper glyph of an attached file. */
export const G = {
  chev: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2h5l3 3v9H4z"/><path d="M9 2v3h3"/></svg>',
};

/** What kind of file was handed over. */
export const FICON: Record<'doc' | 'image' | 'audio' | 'video' | 'sheet', string> = {
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="m4.5 16 4-4 3.5 3.5 2.5-2.5 5 4"/><circle cx="15.5" cy="9.5" r="1.2"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="m10.5 9.5 4 2.5-4 2.5z"/></svg>',
  sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/></svg>',
};
