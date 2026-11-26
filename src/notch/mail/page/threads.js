// Threads in full (args.ids: thread ids from the list), each read from the page
// Gmail makes for printing it. Answers one entry per id:
// { id, subject, messages: [{ from, to, cc, at, text, files }] } or { id, failed }.
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
const BLOCK = new Set(['P', 'DIV', 'TR', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'BLOCKQUOTE', 'PRE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
const SKIP = new Set(['STYLE', 'SCRIPT', 'HEAD', 'TITLE', 'IMG', 'SVG', 'NOSCRIPT']);
// What the sender hid from the eye. These words go to a model, and what the model writes is sent in
// the owner's name: text that only the model would read is an instruction slipped past the owner, so
// it is not read. Only what an element says of itself, in its own style attribute, can be asked:
// this page is never drawn, so nothing is known of what a style sheet or a class does, nor of white
// words on white. It is a first fence, not the wall: the wall is that the owner sees the letter
// before it goes.
//
// Two kinds of hiding, and they are not treated alike:
//   - not drawn at all, see-through, or given no room with the rest cut off: nothing inside it can
//     be brought back, so everything in it is left out (`cut`);
//   - no size of letters, or not visible: what is inside can set its own size, or be visible again,
//     and then it is seen. Mail made with the common tools sets font-size:0 on the cell that holds
//     its columns and a size on each column. So only the words that have no size, or are not
//     visible, where they stand are left out, and what is inside is still gone through.
const ZERO = /^[+-]?(0+(\.0*)?|\.0+)(px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|q|%)?$/;
const SIZED = /^[+-]?(\d+\.?\d*|\.\d+)(px|pt|pc|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|q|%)$/;
// What an element's own style says, the last word on each thing standing. Comments and "!important"
// are not part of a value.
const declared = (node) => {
  const style = node.getAttribute('style');
  if (!style) return null;
  const says = {};
  for (const one of style.toLowerCase().replace(/\/\*[\s\S]*?\*\//g, '').replace(/!\s*important/g, '').split(';')) {
    const at = one.indexOf(':');
    if (at <= 0) continue;
    const name = one.slice(0, at).trim();
    const value = one.slice(at + 1).trim().replace(/\s+/g, ' ');
    if (name === 'font') {
      // The short form sets a size every time: the one it names (before a "/" and the line height), or a usual one.
      const size = value.split(' ').map((word) => word.split('/')[0]).find((word) => ZERO.test(word) || SIZED.test(word));
      says['font-size'] = size === undefined ? 'medium' : size;
    } else {
      says[name] = value;
    }
  }
  return says;
};
// Not drawn, see-through, or no room with what does not fit cut off: nothing in it is seen.
const cut = (node) => {
  if (node.hasAttribute('hidden')) return true;
  const says = declared(node);
  if (!says) return false;
  if (says.display === 'none' || says['mso-hide'] === 'all' || ZERO.test(says.opacity || '')) return true;
  // Which way what does not fit is cut off: across, and downward. One word is both; two are across, then downward.
  const over = (says.overflow || '').split(' ');
  const off = (value) => /^(hidden|clip)/.test(value || '');
  const across = off(says['overflow-x'] !== undefined ? says['overflow-x'] : over[0]);
  const down = off(says['overflow-y'] !== undefined ? says['overflow-y'] : over[1] !== undefined ? over[1] : over[0]);
  return (across && (ZERO.test(says.width || '') || ZERO.test(says['max-width'] || '')))
    || (down && (ZERO.test(says.height || '') || ZERO.test(says['max-height'] || '')));
};
// How words stand in an element, given how they stood round it: with no size, or not visible.
const standing = (node, round) => {
  const says = declared(node);
  if (!says) return round;
  const size = says['font-size'];
  const seen = says.visibility;
  return {
    small: size === undefined || size === 'inherit' ? round.small : ZERO.test(size),
    veiled: seen === 'hidden' || seen === 'collapse' ? true : seen === 'visible' ? false : round.veiled,
  };
};
const textOf = (root) => {
  let out = '';
  const walk = (node, round) => {
    if (node.nodeType === 3) { if (!round.small && !round.veiled) out += node.textContent.replace(/\s+/g, ' '); return; }
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
    if (cut(node)) return;
    const here = standing(node, round);
    // A line break is a line break every time: two of them, or one alone in a block, are the empty line
    // between two paragraphs, which is how the writer set their mail out.
    if (node.tagName === 'BR') { out += '\n'; return; }
    // What a mail program quotes of the earlier messages: the thread already has them.
    if (node.tagName === 'BLOCKQUOTE' || node.classList.contains('gmail_quote') || node.classList.contains('gmail_extra') || node.id === 'divRplyFwdMsg') {
      // A forwarded message is the point of the mail that carries it, so it stays.
      if (!/forwarded message|messaggio inoltrato/i.test(node.textContent.slice(0, 200))) { out += '\n'; return; }
    }
    if (node.tagName === 'A') {
      // A link is its words and where it goes. The words alone ("book a time here") are not the link:
      // the address is left beside them, between marks, and ../gmail.ts decides how it is shown.
      const before = out.length;
      for (const child of node.childNodes) walk(child, here);
      if (out.length === before) {
        // A picture that is a link says what it is in its alt: a picture that is itself shown, in
        // nothing between it and the link that is not. A picture has its size whatever the letters have.
        const shown = (picture) => {
          let veiled = here.veiled;
          const chain = [];
          for (let at = picture; at && at !== node; at = at.parentElement) { if (cut(at)) return false; chain.unshift(at); }
          for (const at of chain) {
            const seen = (declared(at) || {}).visibility;
            if (seen === 'hidden' || seen === 'collapse') veiled = true; else if (seen === 'visible') veiled = false;
          }
          return !veiled;
        };
        const pictures = [...node.querySelectorAll('img')];
        const picture = pictures.find((one) => one.hasAttribute('alt') && shown(one));
        const alt = picture ? (picture.getAttribute('alt') || '').replace(/\s+/g, ' ').trim() : '';
        if (alt) out += alt;
        // A link with nothing of it seen (its words have no size or are not visible, its pictures
        // are hidden) is not left as a bare address: nobody reading the mail sees that link.
        else if (here.small || here.veiled || (pictures.length > 0 && !pictures.some(shown))) return;
      }
      const href = node.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) out += ` ⟦${href.replace(/\s/g, '')}⟧`;
      return;
    }
    const block = BLOCK.has(node.tagName);
    if (block && !out.endsWith('\n')) out += '\n';
    for (const child of node.childNodes) walk(child, here);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  walk(root, { small: false, veiled: false });
  return out.split('\n').map((line) => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

// Gmail lets no script turn text into a page (Trusted Types), so the browser is
// asked to do the parsing itself: a request whose answer is a document.
const printed = (id) => new Promise((resolve) => {
  const request = new XMLHttpRequest();
  request.open('GET', `${base}?ui=2&ik=${key}&view=pt&search=all&th=${id}&hl=en`);
  request.responseType = 'document';
  request.withCredentials = true;
  request.timeout = 25000;
  request.onload = () => resolve(request);
  request.onerror = () => resolve(null);
  request.ontimeout = () => resolve(null);
  request.send();
});

const one = async (id) => {
  const fail = (failed) => ({ id, failed, subject: '', messages: [] });
  if (!/^[0-9a-f]{16}$/.test(id)) return fail('no thread id');
  const request = await printed(id);
  if (!request) return fail('could not be fetched');
  if (request.status !== 200) return fail('status ' + request.status);
  if (new URL(request.responseURL).hostname !== 'mail.google.com') return fail('sent elsewhere');
  const doc = request.responseXML;
  if (!doc) return fail('not a page');
  const tables = [...doc.querySelectorAll('table.message')];
  if (!tables.length) return fail('no messages in the print page');
  const title = doc.querySelector('.maincontent font[size="+1"] b, .maincontent b');
  const messages = tables.map((table) => {
    // The first row: who wrote it, and when. The second: who it went to. The third: what it says.
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    const head = rows[0];
    const cells = head ? [...head.children].filter((cell) => cell.tagName === 'TD') : [];
    const lines = [...table.querySelectorAll('.recipient div')].map((div) => div.textContent.trim());
    const line = (label) => (lines.find((entry) => entry.toLowerCase().startsWith(label + ':')) || '').slice(label.length + 1).trim();
    // The third row holds a table of one cell: the message in its first block, and under it the list of files that came with it.
    const cell = rows[2] ? rows[2].querySelector(':scope > td > table > tbody > tr > td') : null;
    const body = cell ? (cell.querySelector(':scope > div') || cell) : null;
    return {
      from: cells[0] ? cells[0].textContent.trim() : '',
      to: line('to'),
      cc: line('cc'),
      at: when(cells[1] ? cells[1].textContent : ''),
      text: body ? textOf(body) : '',
      // The files that came with it, by name: each is listed under the message with its name in bold.
      files: cell ? [...cell.querySelectorAll('table.att b')].map((name) => name.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12) : [],
    };
  });
  return { id, subject: title ? title.textContent.trim() : '', messages };
};

const out = [];
// Two at a time, with a breath between: asked faster than this for long, Gmail
// starts answering with pages that have no mail in them.
for (let at = 0; at < args.ids.length; at += 2) {
  out.push(...await Promise.all(args.ids.slice(at, at + 2).map(one)));
  await new Promise((resolve) => setTimeout(resolve, 250));
}
return out;
