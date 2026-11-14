// The build of the events of the week on screen: tags, classes, attribute
// names and counts. No title, no time, no name, no attribute value but a role.
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
const tally = (list) => { const out = {}; for (const item of list) out[item] = (out[item] || 0) + 1; return out; };
const all = [...document.querySelectorAll('[data-eventid]')];
const chips = all.filter((node) => node.hasAttribute('data-eventchip'));
const others = all.filter((node) => !node.hasAttribute('data-eventchip'));
const decode = (key) => { const n = Number(key); return new Date((n >> 9) + 1970, ((n >> 5) & 15) - 1, n & 31); };
const keys = [...new Set([...document.querySelectorAll('[data-datekey]')].map((node) => node.dataset.datekey))];
const days = keys.map(decode);
const near = days.filter((day) => Math.abs(day.getTime() - Date.now()) < 8 * 86400000).length;
const consecutive = days.slice().sort((a, b) => a - b).every((day, at, list) => at === 0 || Math.round((day - list[at - 1]) / 86400000) === 1);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const line = (chip) => [...chip.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent.includes(', ')).map((node) => node.textContent)[0] || '';
const lineNode = (chip) => [...chip.querySelectorAll('*')].find((node) => node.children.length === 0 && node.textContent.includes(', '));
// Does the date at the end of a chip's hidden line name the day its column is keyed with?
const agrees = chips.filter((chip) => {
  const found = /, ([A-Z][a-z]+) (\d{1,2}), (\d{4})$/.exec(line(chip));
  const cell = chip.closest('[data-datekey]');
  if (!found || !cell) return false;
  const day = decode(cell.dataset.datekey);
  return MONTHS.indexOf(found[1].toLowerCase()) === day.getMonth() && Number(found[2]) === day.getDate() && Number(found[3]) === day.getFullYear();
}).length;
const separators = tally(chips.map((chip) => (/^\S+ (\S+) /.exec(line(chip)) || [])[1] === 'to' ? 'to' : 'other'));
const commas = tally(chips.map((chip) => String(line(chip).split(', ').length)));
// Is the title somewhere of its own, as a leaf whose text the hidden line contains after the time?
const titled = chips.filter((chip) => {
  const hidden = lineNode(chip);
  const rest = line(chip).slice(line(chip).indexOf(', ') + 2);
  return [...chip.querySelectorAll('*')].some((node) => node !== hidden && node.children.length === 0 && node.textContent.trim().length > 0 && rest.startsWith(node.textContent.trim()));
}).length;
const top = (px) => Math.round(parseFloat(px) || 0);
return {
  dateKeysDecodeNearToday: near,
  dateKeysOf: keys.length,
  dateKeysConsecutive: consecutive,
  chips: chips.length,
  chipRoles: tally(chips.map((chip) => chip.attributes.role ? chip.attributes.role.value : 'none')),
  chipDayAgreesWithLine: agrees,
  chipSeparators: separators,
  chipLineParts: commas,
  chipsWithTitleOfItsOwn: titled,
  chipHiddenLineClass: tally(chips.map((chip) => { const node = lineNode(chip); return node ? node.tagName.toLowerCase() + '.' + String(node.className).split(/\s+/).join('.') : 'none'; })),
  chipStyleHasTopAndHeight: chips.filter((chip) => chip.style.top && chip.style.height).length,
  chipSkeleton: chips[0] ? skeleton(chips[0], 4) : null,
  others: others.length,
  otherAttributeNames: tally(others.map((node) => [...node.attributes].map((attr) => attr.name).sort().join(','))),
  otherRoles: tally(others.map((node) => node.attributes.role ? node.attributes.role.value : 'none')),
  othersInsideADay: others.filter((node) => node.closest('[data-datekey]')).length,
  othersInsideAChip: others.filter((node) => node.parentElement && node.parentElement.closest('[data-eventid]')).length,
  otherLineKinds: tally(others.map((node) => { const text = line(node) || node.textContent; return /^all day, /i.test(text) ? 'all-day' : /^\d{1,2}(:\d{2})?\s?(am|pm)/i.test(text) ? 'timed' : text ? 'other' : 'empty'; })),
  otherLineEnd: tally(others.map((node) => { const text = line(node) || node.textContent; return /, [A-Z][a-z]+ \d{1,2}, \d{4}$/.test(text) ? 'one day' : /[A-Z][a-z]+ \d{1,2} – (?:[A-Z][a-z]+ )?\d{1,2}, \d{4}$/.test(text) ? 'a range of days' : 'other'; })),
  otherSkeleton: others[0] ? skeleton(others[0], 4) : null,
  hourRows: document.querySelectorAll('[role="row"]').length,
  gridHeight: (() => { const cell = document.querySelector('div[role="gridcell"][data-datekey]'); return cell ? Math.round(cell.getBoundingClientRect().height) : null; })(),
};
