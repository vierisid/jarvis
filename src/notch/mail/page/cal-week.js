// Reads the week that Google Calendar is showing (its week view, in English:
// ".../r/week/2026/11/16?hl=en"), once the week holding args.day ("2026-11-16")
// is on screen. Answers with the days of that week and its events.
//
// What is read is what the person sees: the events of every calendar they have
// switched on. An event's day comes from the column it is drawn in, which
// Google keys with a number, and its hours from the line Google writes for
// screen readers ("9am to 10:30am, Title, ..."). An event that is written any
// other way is counted and left out, never guessed at.
if (location.hostname === 'accounts.google.com') return { state: 'signed-out' };
if (location.hostname !== 'calendar.google.com') return { state: 'elsewhere' };
const pad = (n) => String(n).padStart(2, '0');
const iso = (day) => `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
const decode = (key) => { const n = Number(key); return new Date((n >> 9) + 1970, ((n >> 5) & 15) - 1, n & 31); };
const columns = () => [...document.querySelectorAll('div[role="gridcell"][data-datekey]')]
  .filter((cell) => /^\d+$/.test(cell.dataset.datekey))
  .map((cell) => ({ cell, day: decode(cell.dataset.datekey) }))
  .sort((a, b) => a.day - b.day);
const wait = async (found, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = found();
    if (value || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
const wanted = String((args && args.day) || '');
const shown = await wait(() => { const days = columns(); return days.length >= 1 && days.length <= 7 && days.some((entry) => iso(entry.day) === wanted) ? days : null; }, (args && args.wait) || 15000);
if (!shown) return { state: document.querySelector('[data-datekey]') ? 'another-week' : 'not-up' };

// The events are drawn after the days are: read once their number has stood still.
const count = () => document.querySelectorAll('[data-eventchip]').length;
const since = Date.now();
let last = count();
let still = Date.now();
while (Date.now() - since < 9000) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const now = count();
  if (now !== last) { last = now; still = Date.now(); }
  if (Date.now() - still >= 1250 && Date.now() - since >= 1750) break;
}

// The hours the calendar shows are in its own time zone. They are turned into
// moments with this browser's, so the two have to be the same.
const label = [...document.querySelectorAll('div, span')].map((node) => (node.children.length === 0 ? node.textContent.trim() : '')).find((text) => /^GMT[+-]\d{1,2}(:\d{2})?$/.test(text)) || '';
const labelled = label ? (label[3] === '-' ? -1 : 1) * (Number(label.slice(4).split(':')[0]) * 60 + Number(label.slice(4).split(':')[1] || 0)) : null;
const zoneAgrees = labelled === null ? null : labelled === -new Date().getTimezoneOffset();

const clock = (text) => {
  const found = /^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/i.exec(text.trim());
  if (!found) return null;
  let hour = Number(found[1]);
  const minute = Number(found[2] || 0);
  const half = (found[3] || '').toLowerCase();
  if (half) { if (hour < 1 || hour > 12) return null; hour = (hour % 12) + (half === 'pm' ? 12 : 0); }
  else if (!found[2]) return null; // a bare number is not a time
  return hour < 24 && minute < 60 ? hour * 60 + minute : null;
};
const lineNode = (chip) => [...chip.querySelectorAll('*')].find((node) => node.children.length === 0 && node.textContent.includes(', '));
// The title has a place of its own in the event: the longest piece of it that the hidden line repeats.
const title = (chip, hidden, line) => {
  const own = [...chip.querySelectorAll('*')]
    .filter((node) => node !== hidden && node.children.length === 0)
    .map((node) => node.textContent.trim())
    .filter((text) => text && line.includes(text))
    .sort((a, b) => b.length - a.length)[0];
  // Failing that, the part of the line after "All day" or the hours, or the first when the line starts with the title.
  const parts = line.split(', ');
  const led = /^all day$/i.test(parts[0]) || / to /.test(parts[0]);
  return (own || (led ? parts[1] : parts[0]) || '').slice(0, 200);
};

const events = [];
let unread = 0;
let declined = 0;
const seen = new Set();
for (const chip of document.querySelectorAll('[data-eventchip]')) {
  const hidden = lineNode(chip);
  const line = hidden ? hidden.textContent.trim() : '';
  const parts = line.split(', ');
  const id = chip.dataset.eventid || '';
  if (!line || !id) { unread++; continue; }
  if (parts.slice(1).some((part) => part === 'Declined')) { declined++; continue; }
  const column = shown.find((entry) => entry.cell.contains(chip));
  if (column) {
    // An event with hours, in the column of its day.
    const times = /^(.+?) to (.+)$/.exec(parts[0]);
    const from = times ? clock(times[1]) : null;
    const to = times ? clock(times[2]) : null;
    if (from === null || to === null) { unread++; continue; }
    const day = column.day;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, from);
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (to <= from ? 1 : 0), 0, to);
    const key = `${id} ${start.getTime()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ id, summary: title(chip, hidden, line), start: start.toISOString(), end: end.toISOString(), allDay: false });
    continue;
  }
  // A whole-day event, in the row above the hours: its days are the columns it lies over.
  if (!/^all day$/i.test(parts[0]) && !/^all day$/i.test(parts[parts.length - 1])) { unread++; continue; }
  const box = chip.getBoundingClientRect();
  const over = shown.filter((entry) => { const cell = entry.cell.getBoundingClientRect(); return box.width > 0 && box.left < cell.right - 2 && box.right > cell.left + 2; });
  if (over.length === 0) { unread++; continue; }
  const first = over[0].day;
  const final = over[over.length - 1].day;
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const end = new Date(final.getFullYear(), final.getMonth(), final.getDate() + 1);
  const key = `${id} ${start.getTime()}`;
  if (seen.has(key)) continue;
  seen.add(key);
  events.push({ id, summary: title(chip, hidden, line), start: start.toISOString(), end: end.toISOString(), allDay: true });
}
return { state: 'read', days: shown.map((entry) => iso(entry.day)), zoneAgrees, events, unread, declined };
