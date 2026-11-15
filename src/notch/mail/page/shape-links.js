// What the links and the attached files of some threads are built like in
// Gmail's print page (args.ids: thread ids). Counts, tags and attribute names.
// No address, no word of a mail, no file name.
const key = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[9] === 'string' ? GLOBALS[9] : null;
if (!key) throw new Error('no key for this mailbox in the page');
const base = location.origin + location.pathname;
const printed = (id) => new Promise((resolve) => {
  const request = new XMLHttpRequest();
  request.open('GET', `${base}?ui=2&ik=${key}&view=pt&search=all&th=${id}&hl=en`);
  request.responseType = 'document';
  request.withCredentials = true;
  request.timeout = 25000;
  request.onload = () => resolve(request.responseXML);
  request.onerror = () => resolve(null);
  request.ontimeout = () => resolve(null);
  request.send();
});
const skeleton = (node, depth) => {
  const attrs = [...node.attributes].map((attr) => attr.name).filter((name) => name !== 'style').join(',');
  const texts = [...node.childNodes].filter((child) => child.nodeType === 3 && child.textContent.trim()).length;
  const head = node.tagName.toLowerCase() + (attrs ? `[${attrs}]` : '') + (texts ? `"${texts}"` : '');
  if (depth <= 0) return node.children.length ? head + '{…}' : head;
  const groups = [];
  for (const kid of node.children) {
    const text = skeleton(kid, depth - 1);
    if (groups.length && groups.at(-1).text === text) groups.at(-1).times++;
    else groups.push({ text, times: 1 });
  }
  return head + (groups.length ? '{' + groups.map((group) => (group.times > 1 ? group.times + '×' : '') + group.text).join(' ') + '}' : '');
};
const total = { threads: 0, messages: 0, links: 0, web: 0, mail: 0, other: 0, shownInWords: 0, hiddenBehindWords: 0, hiddenBehindAPicture: 0, throughGoogle: 0, longerThan200: 0, attachmentTables: 0, messagesWithHiddenLinks: 0 };
let attachment = null;
for (const id of (args.ids || []).slice(0, 12)) {
  const doc = await printed(id);
  if (!doc) continue;
  total.threads++;
  for (const table of doc.querySelectorAll('table.message')) {
    total.messages++;
    const rows = [...table.querySelectorAll(':scope > tbody > tr')];
    const cell = rows[2] ? rows[2].querySelector(':scope > td > table > tbody > tr > td') : null;
    const body = cell ? (cell.querySelector(':scope > div') || cell) : null;
    if (!body) continue;
    let hidden = 0;
    for (const link of body.querySelectorAll('a[href]')) {
      total.links++;
      const raw = link.getAttribute('href') || '';
      if (/^mailto:/i.test(raw)) { total.mail++; continue; }
      if (!/^https?:/i.test(raw)) { total.other++; continue; }
      total.web++;
      let host = '';
      try { const parsed = new URL(raw); host = parsed.hostname; if (parsed.hostname === 'www.google.com' && parsed.pathname === '/url') total.throughGoogle++; } catch { /* not an address */ }
      if (raw.length > 200) total.longerThan200++;
      const words = link.textContent.trim();
      if (words && host && words.includes(host)) total.shownInWords++;
      else if (words) { total.hiddenBehindWords++; hidden++; }
      else { total.hiddenBehindAPicture++; hidden++; }
    }
    if (hidden) total.messagesWithHiddenLinks++;
    const files = cell ? [...cell.querySelectorAll('table.att')] : [];
    total.attachmentTables += files.length;
    if (files[0] && !attachment) {
      const inner = files[0].querySelector('table table') || files[0].querySelector('table') || files[0];
      attachment = { build: skeleton(inner, 7), bolds: files[0].querySelectorAll('b').length, links: files[0].querySelectorAll('a').length, pictures: files[0].querySelectorAll('img').length, textNodes: (() => { let n = 0; const walk = (node) => { for (const child of node.childNodes) { if (child.nodeType === 3 && child.textContent.trim()) n++; else if (child.nodeType === 1) walk(child); } }; walk(files[0]); return n; })() };
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
return { total, attachment };
