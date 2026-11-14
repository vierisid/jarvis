// The build of one row of the list (args.row, 0 by default): tags, classes and
// attribute names. No text and no attribute values.
const main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null);
const row = main ? main.querySelectorAll('tr.zA')[(args && args.row) || 0] : null;
if (!row) throw new Error('no such row');
const skeleton = (node, depth) => {
  const cls = typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).join('.') : '';
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
return { skeleton: skeleton(row, 7) };
