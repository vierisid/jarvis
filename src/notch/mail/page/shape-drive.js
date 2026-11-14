// Is this Google Drive, signed in, and what is a list of files built like there?
// Shapes only: counts, tags, attribute names, yes or no. No file name, no owner, no id.
const host = location.hostname === 'drive.google.com' ? 'drive'
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
const items = () => [...document.querySelectorAll('[data-id]')].filter((node) => node.offsetParent !== null);
if (host === 'drive') await wait(() => items().length > 0 || document.querySelector('[role="main"] [role="status"], [role="main"] img[alt=""]'), (args && args.wait) || 12000);
await new Promise((resolve) => setTimeout(resolve, 1500));
const found = items();
const tally = (list) => { const out = {}; for (const item of list) out[item] = (out[item] || 0) + 1; return out; };
const head = (node) => node.tagName.toLowerCase() + (node.attributes.role ? '[' + node.attributes.role.value + ']' : '');
const names = (node) => [...node.attributes].map((attr) => attr.name).filter((name) => name !== 'class' && name !== 'style').sort().join(',');
const skeleton = (node, depth) => {
  const attrs = names(node);
  const texts = [...node.childNodes].filter((child) => child.nodeType === 3 && child.textContent.trim()).length;
  const top = head(node) + (attrs ? `{${attrs}}` : '') + (texts ? `"${texts}"` : '');
  if (depth <= 0) return node.children.length ? top + '(…)' : top;
  const groups = [];
  for (const kid of node.children) {
    const text = skeleton(kid, depth - 1);
    if (groups.length && groups.at(-1).text === text) groups.at(-1).times++;
    else groups.push({ text, times: 1 });
  }
  return top + (groups.length ? '(' + groups.map((group) => (group.times > 1 ? group.times + '×' : '') + group.text).join(' ') + ')' : '');
};
const rows = found.filter((node) => node.attributes.role && node.attributes.role.value === 'row');
return {
  host,
  path: location.pathname.split('/').slice(0, 4).join('/'),
  lang: document.documentElement.lang,
  main: !!document.querySelector('[role="main"]'),
  items: found.length,
  itemHeads: tally(found.map(head)),
  itemAttributeNames: tally(found.map(names)),
  idShapes: tally(found.map((node) => (/^[A-Za-z0-9_-]{20,}$/.test(node.dataset.id) ? 'a file id' : 'other'))),
  grids: document.querySelectorAll('[role="grid"]').length,
  columnHeaders: document.querySelectorAll('[role="columnheader"]').length,
  rows: rows.length,
  cellsPerRow: tally(rows.map((row) => String(row.querySelectorAll('[role="gridcell"]').length))),
  rowsWithLabel: rows.filter((row) => row.hasAttribute('aria-label')).length,
  rowSkeleton: rows[0] ? skeleton(rows[0], 5) : found[0] ? skeleton(found[0], 5) : null,
  visible: document.visibilityState,
};
