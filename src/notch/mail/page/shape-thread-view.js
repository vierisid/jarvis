// Is a thread open, and what is there to press in it? Counts, classes and Gmail's own button names. No mail.
const visible = (node) => !!node && node.offsetParent !== null;
const named = (node) => (node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || '').trim();
const buttons = [...document.querySelectorAll('[role="button"], [role="link"]')].filter(visible);
// Gmail's own names for its buttons, kept only when they are one of the few this study presses.
const known = /^(reply|reply all|forward|discard draft|send|more|back to|archive|delete)\b/i;
return {
  hash: location.hash.replace(/[0-9a-f]{16}/gi, '<id>').replace(/[^#/<>a-z_]/gi, '?').slice(0, 40),
  messages: document.querySelectorAll('[data-message-id]').length,
  legacyMessages: document.querySelectorAll('[data-legacy-message-id]').length,
  listRowsSeen: [...document.querySelectorAll('tr.zA')].filter(visible).length,
  ams: [...document.querySelectorAll('span.ams')].filter(visible).map((node) => (node.className || '').toString()),
  pressable: [...new Set(buttons.map(named).filter((name) => known.test(name)).map((name) => name.replace(/[‪-‮]/g, '').slice(0, 40)))],
  replyCandidates: buttons.filter((node) => /^reply$/i.test(named(node)) || /^reply$/i.test((node.textContent || '').trim())).map((node) => node.tagName.toLowerCase() + '.' + (node.className || '').toString().trim().split(/\s+/).slice(0, 4).join('.')),
  editables: [...document.querySelectorAll('[contenteditable="true"]')].filter(visible).length,
};
