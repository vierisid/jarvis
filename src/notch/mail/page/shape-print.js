// What Gmail's print view of one thread looks like (the thread of args.row in
// the list, 0 by default): which way of asking for it works, and the build of
// what comes back. Tags, classes, attribute names and counts. No text.
const main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null);
const row = main ? main.querySelectorAll('tr.zA')[(args && args.row) || 0] : null;
// args.id names a thread outright (an id is sixteen hex digits and says nothing of the mail).
const hex = args && /^[0-9a-f]{16}$/.test(args.id || '') ? args.id
  : row && row.querySelector('[data-legacy-thread-id]') ? row.querySelector('[data-legacy-thread-id]').getAttribute('data-legacy-thread-id') : null;
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
// Gmail lets no script turn text into a page (Trusted Types), so the browser is
// asked to do the parsing itself: a request whose answer is a document.
const fetchDocument = (url) => new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('GET', url);
  request.responseType = 'document';
  request.withCredentials = true;
  request.timeout = 20000;
  request.onload = () => resolve(request);
  request.onerror = () => reject(new Error('request failed'));
  request.ontimeout = () => reject(new Error('request timed out'));
  request.send();
});
const found = {};
for (const [name, url] of Object.entries(ways)) {
  try {
    const started = Date.now();
    const request = await fetchDocument(url);
    const doc = request.responseXML;
    if (!doc) { found[name] = { status: request.status, document: false, type: (request.getResponseHeader('content-type') || '').split(';')[0] }; continue; }
    const messages = [...doc.querySelectorAll('table.message')];
    found[name] = {
      status: request.status,
      ms: Date.now() - started,
      type: (request.getResponseHeader('content-type') || '').split(';')[0],
      landed: new URL(request.responseURL).hostname === 'mail.google.com' ? 'mail' : 'elsewhere',
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
    // The reason in the browser's own words, without any address it may carry.
    found[name] = { failed: String(error && error.name || 'error'), why: String(error && error.message || '').replace(/\S+:\/\/\S+/g, '(an address)').slice(0, 160) };
  }
}
return { rowCount: row && row.querySelector('span.bx0') ? 'has a count' : 'single', found };
