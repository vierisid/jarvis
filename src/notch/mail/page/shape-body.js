// How the text of one message sits in Gmail's print view (the thread of args.row
// in the list, message args.message, both 0 by default). Tags, classes and lengths. No text.
const main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null);
const rows = main ? [...main.querySelectorAll('tr.zA')] : [];
const row = (args && args.many) ? rows.find((entry) => entry.querySelector('span.bx0')) : rows[(args && args.row) || 0];
const hex = row && row.querySelector('[data-legacy-thread-id]') ? row.querySelector('[data-legacy-thread-id]').getAttribute('data-legacy-thread-id') : null;
if (!hex) throw new Error('no thread in that row');
const key = GLOBALS[9];
const request = await new Promise((resolve) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', `${location.origin + location.pathname}?ui=2&ik=${key}&view=pt&search=all&th=${hex}&hl=en`);
  xhr.responseType = 'document';
  xhr.withCredentials = true;
  xhr.onload = () => resolve(xhr);
  xhr.onerror = () => resolve(null);
  xhr.send();
});
if (!request || !request.responseXML) throw new Error('the print page did not come');
const tables = [...request.responseXML.querySelectorAll('table.message')];
const table = tables[(args && args.message) || 0];
if (!table) throw new Error('no such message');
const skeleton = (node, depth) => {
  const cls = typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
  const texts = [...node.childNodes].filter((child) => child.nodeType === 3 && child.textContent.trim()).map((child) => child.textContent.trim().length);
  const head = node.tagName.toLowerCase() + cls + (texts.length ? `"${texts.join('+')}"` : '');
  if (depth <= 0) return node.children.length ? head + '{…}' : head;
  const groups = [];
  for (const kid of node.children) {
    const text = skeleton(kid, depth - 1);
    if (groups.length && groups.at(-1).text === text) groups.at(-1).times++;
    else groups.push({ text, times: 1 });
  }
  return head + (groups.length ? '{' + groups.map((group) => (group.times > 1 ? group.times + '×' : '') + group.text).join(' ') + '}' : '');
};
const trs = [...table.querySelectorAll(':scope > tbody > tr')];
return {
  messages: tables.length,
  rowsInMessage: trs.length,
  rowTextLengths: trs.map((tr) => tr.textContent.trim().length),
  firstNestedCell: (table.querySelector('table td') || { textContent: '' }).textContent.trim().length,
  body: trs[2] ? skeleton(trs[2], 9).slice(0, 2200) : null,
};
