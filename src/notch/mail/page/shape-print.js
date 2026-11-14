// What Gmail's print view of one thread looks like (the thread of args.row in
// the list, 0 by default): which way of asking for it works, and the build of
// what comes back. Tags, classes, attribute names and counts. No text.
const main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null);
const row = main ? main.querySelectorAll('tr.zA')[(args && args.row) || 0] : null;
const hex = row && row.querySelector('[data-legacy-thread-id]') ? row.querySelector('[data-legacy-thread-id]').getAttribute('data-legacy-thread-id') : null;
if (!hex) throw new Error('no thread in that row');
const key = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[9] === 'string' ? GLOBALS[9] : null;
if (!key) throw new Error('no key for this mailbox in the page');
const letters = (text) => String(text || '').replace(/\p{Lu}/gu, 'A').replace(/\p{Ll}/gu, 'a').replace(/\d/g, '9');
const base = location.origin + location.pathname;
const ways = {
  old: `${base}?ui=2&ik=${key}&view=pt&search=all&th=${hex}&hl=en`,
  new: `${base}?ik=${key}&view=pt&search=all&permthid=${encodeURIComponent('thread-f:' + BigInt('0x' + hex).toString())}&hl=en`,
};
const skeleton = (node, depth) => {
  const cls = typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
  const attrs = [...node.attributes].map((attr) => attr.name).filter((name) => name !== 'class' && name !== 'style').join(',');
  const texts = [...node.childNodes].filter((child) => child.nodeType === 3 && child.textContent.trim()).length;
  const head = node.tagName.toLowerCase() + cls + (attrs ? `[${attrs}]` : '') + (texts ? `"${texts}"` : '');
  if (depth <= 0) return node.children.length ? head + '{…}' : head;
  const groups = [];
  for (const kid of node.children) {
    const text = skeleton(kid, depth - 1);
    if (groups.length && groups.at(-1).text === text) groups.at(-1).times++;
    else groups.push({ text, times: 1 });
  }
  return head + (groups.length ? '{' + groups.map((group) => (group.times > 1 ? group.times + '×' : '') + group.text).join(' ') + '}' : '');
};
const found = {};
for (const [name, url] of Object.entries(ways)) {
  try {
    const started = Date.now();
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const messages = [...doc.querySelectorAll('table.message')];
    found[name] = {
      status: res.status,
      ms: Date.now() - started,
      type: (res.headers.get('content-type') || '').split(';')[0],
      length: html.length,
      landed: new URL(res.url).hostname === 'mail.google.com' ? 'mail' : 'elsewhere',
      messages: messages.length,
      recipients: doc.querySelectorAll('.recipient').length,
      body: messages.length ? null : skeleton(doc.body, 5).slice(0, 1500),
      first: messages.length ? skeleton(messages[0], 6).slice(0, 2500) : null,
      around: messages.length ? skeleton(messages[0].parentElement, 1).slice(0, 1500) : null,
      dates: messages.slice(0, 5).map((message) => {
        const cell = message.querySelector('td[align="right"]');
        return cell ? letters(cell.textContent.trim()) : null;
      }),
    };
  } catch (error) {
    found[name] = { failed: String(error && error.name || 'error') };
  }
}
return { rowCount: row.querySelector('span.bx0') ? 'has a count' : 'single', found };
