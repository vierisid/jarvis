// Is this Google Calendar, signed in, and what is its week built like?
// Shapes only: counts, attribute names, yes or no. No title, no time, no name.
const host = location.hostname === 'calendar.google.com' ? 'calendar'
  : location.hostname === 'accounts.google.com' ? 'sign-in'
  : location.hostname.endsWith('.google.com') ? 'google-other' : 'other';
const wait = async (found, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = found();
    if (value || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const up = host === 'calendar' ? await wait(() => document.querySelector('[data-datekey]'), (args && args.wait) || 15000) : null;
// A moment more: the events are drawn after the days are.
if (up) await wait(() => document.querySelector('[data-eventid]'), 4000);
const chips = [...document.querySelectorAll('[data-eventchip]')];
const events = [...document.querySelectorAll('[data-eventid]')];
const keys = [...document.querySelectorAll('[data-datekey]')];
const names = (node) => [...node.attributes].map((attr) => attr.name).sort().join(',');
const tally = (list) => { const out = {}; for (const item of list) out[item] = (out[item] || 0) + 1; return out; };
const hidden = (chip) => [...chip.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent.includes(', ')).map((node) => node.textContent)[0] || '';
const texts = chips.map(hidden);
const kinds = {
  twelve: /^\d{1,2}(:\d{2})?\s?(am|pm) (to|–|-) \d{1,2}(:\d{2})?\s?(am|pm), /i,
  twentyFour: /^\d{1,2}:\d{2} (to|–|-) \d{1,2}:\d{2}, /,
  allDay: /^all day, /i,
  endsWithYear: /, \d{4}$/,
  endsWithMonthDayYear: /, [A-Z][a-z]+ \d{1,2}, \d{4}$/,
  endsWithDayMonthYear: /, \d{1,2} [A-Z][a-z]+ \d{4}$/,
  empty: /^$/,
};
const matched = {};
for (const [kind, shape] of Object.entries(kinds)) matched[kind] = texts.filter((text) => shape.test(text)).length;
const offset = -new Date().getTimezoneOffset();
const corner = [...document.querySelectorAll('div, span')].filter((node) => node.children.length === 0 && /^GMT[+-]\d{1,2}(:\d{2})?$/.test(node.textContent.trim())).map((node) => node.textContent.trim())[0] || '';
const cornerMinutes = corner ? (corner[3] === '-' ? -1 : 1) * (Number(corner.slice(4).split(':')[0]) * 60 + Number(corner.slice(4).split(':')[1] || 0)) : null;
const parentKeyed = chips.filter((chip) => chip.closest('[data-datekey]')).length;
return {
  host,
  path: location.pathname.split('/').map((part) => (/^\d+$/.test(part) ? '#' : part)).join('/'),
  lang: document.documentElement.lang,
  up: !!up,
  dateKeys: keys.length,
  distinctDateKeys: new Set(keys.map((node) => node.dataset.datekey)).size,
  dateKeyTags: tally(keys.map((node) => node.tagName.toLowerCase() + '[' + (node.attributes.role ? 'role=' + node.attributes.role.value : '') + ']')),
  dateKeysAreNumbers: keys.every((node) => /^\d+$/.test(node.dataset.datekey)),
  eventIds: events.length,
  chips: chips.length,
  chipAttributeNames: tally(chips.map(names)),
  chipsInsideADay: parentKeyed,
  chipsWithHiddenLine: texts.filter(Boolean).length,
  hiddenLineKinds: matched,
  zoneLabelFound: !!corner,
  zoneLabelMatchesBrowser: cornerMinutes === null ? null : cornerMinutes === offset,
  visible: document.visibilityState,
};
