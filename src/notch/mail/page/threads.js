// Threads in full (args.ids: thread ids from the list), each read from the page
// Gmail makes for printing it. Answers one entry per id:
// { id, subject, messages: [{ from, to, cc, at, text }] } or { id, failed }.
const key = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[9] === 'string' ? GLOBALS[9] : null;
if (!key) throw new Error('no key for this mailbox in the page');
const base = location.origin + location.pathname;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// "Tue, Nov 10, 2026 at 3:04 PM", in this computer's own time. The page is asked for in English (hl=en).
const when = (text) => {
  const found = /([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4})(?:,| at)? (\d{1,2}):(\d{2})\s*([AP]M)?/.exec(String(text).replace(/[  ]/g, ' '));
  if (!found) return null;
  const month = MONTHS[found[1].toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(found[4]);
  if (found[6] === 'PM' && hour < 12) hour += 12;
  if (found[6] === 'AM' && hour === 12) hour = 0;
  const at = new Date(Number(found[3]), month, Number(found[2]), hour, Number(found[5])).getTime();
  return Number.isFinite(at) ? at : null;
};

// The text of a piece of mail, with its line breaks, and without the history quoted inside it.
const BLOCK = new Set(['P', 'DIV', 'BR', 'TR', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
const SKIP = new Set(['STYLE', 'SCRIPT', 'HEAD', 'TITLE', 'IMG', 'SVG', 'NOSCRIPT']);
const textOf = (root) => {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === 3) { out += node.textContent.replace(/\s+/g, ' '); return; }
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
    // What a mail program quotes of the earlier messages: the thread already has them.
    if (node.tagName === 'BLOCKQUOTE' || node.classList.contains('gmail_quote') || node.classList.contains('gmail_extra') || node.id === 'divRplyFwdMsg') {
      // A forwarded message is the point of the mail that carries it, so it stays.
      if (!/forwarded message|messaggio inoltrato/i.test(node.textContent.slice(0, 200))) { out += '\n'; return; }
    }
    const block = BLOCK.has(node.tagName);
    if (block && !out.endsWith('\n')) out += '\n';
    for (const child of node.childNodes) walk(child);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  walk(root);
  return out.split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const one = async (id) => {
  const fail = (failed) => ({ id, failed, subject: '', messages: [] });
  if (!/^[0-9a-f]{16}$/.test(id)) return fail('no thread id');
  let res;
  try {
    res = await fetch(`${base}?ui=2&ik=${key}&view=pt&search=all&th=${id}&hl=en`, { credentials: 'include' });
  } catch {
    return fail('could not be fetched');
  }
  if (!res.ok) return fail('status ' + res.status);
  if (new URL(res.url).hostname !== 'mail.google.com') return fail('sent elsewhere');
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const tables = [...doc.querySelectorAll('table.message')];
  if (!tables.length) return fail('no messages in the print page');
  const title = doc.querySelector('.maincontent font[size="+1"] b, .maincontent b');
  const messages = tables.map((table) => {
    const head = table.querySelector('tr');
    const cells = head ? [...head.querySelectorAll('td')] : [];
    const lines = [...table.querySelectorAll('.recipient div')].map((div) => div.textContent.trim());
    const line = (label) => (lines.find((entry) => entry.toLowerCase().startsWith(label + ':')) || '').slice(label.length + 1).trim();
    const body = table.querySelector('table td') || table.querySelector('tr:last-child td');
    return {
      from: cells[0] ? cells[0].textContent.trim() : '',
      to: line('to'),
      cc: line('cc'),
      at: when(cells[1] ? cells[1].textContent : ''),
      text: body ? textOf(body) : '',
    };
  });
  return { id, subject: title ? title.textContent.trim() : '', messages };
};

const out = [];
// A few at a time: Gmail answers these quickly, and not all at once.
for (let at = 0; at < args.ids.length; at += 3) {
  out.push(...await Promise.all(args.ids.slice(at, at + 3).map(one)));
}
return out;
