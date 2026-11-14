// What the list of threads on this page looks like. Shapes and counts only.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const place = args && args.place;
if (place && location.hash !== place) throw new Error('not at that place yet');
let main = null;
for (let tries = 0; tries < 50; tries++) {
  // Gmail keeps the lists it has shown: the one in view is the one that takes up room.
  main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null) || null;
  if (main && main.querySelector('tr.zA')) break;
  await sleep(200);
}
const letters = (text) => String(text || '').replace(/\p{Lu}/gu, 'A').replace(/\p{Ll}/gu, 'a').replace(/\d/g, '9');
const rows = main ? [...main.querySelectorAll('tr.zA')] : [];
const me = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[10] === 'string' ? GLOBALS[10].toLowerCase() : '';
const count = (test) => rows.filter(test).length;
const people = rows.map((row) => [...row.querySelectorAll('span[email]')]);
const mine = new Set();
for (const list of people) for (const span of list) if ((span.getAttribute('email') || '').toLowerCase() === me) mine.add(span.getAttribute('name') || '');
const dateOf = (row) => row.querySelector('td.xW span[title]');
const pager = main ? [...document.querySelectorAll('.Dj')].find((node) => node.offsetParent !== null) : null;
return {
  lang: document.documentElement.lang || null,
  mains: document.querySelectorAll('div[role="main"]').length,
  rows: rows.length,
  withThread: count((row) => row.querySelector('[data-legacy-thread-id]')),
  threadShape: [...new Set(rows.slice(0, 50).map((row) => letters((row.querySelector('[data-legacy-thread-id]') || { getAttribute: () => '' }).getAttribute('data-legacy-thread-id')).length))],
  threadHex: count((row) => /^[0-9a-f]{16}$/.test((row.querySelector('[data-legacy-thread-id]') || { getAttribute: () => '' }).getAttribute('data-legacy-thread-id') || '')),
  newThreadAttr: count((row) => row.querySelector('[data-thread-id]')),
  unread: count((row) => row.classList.contains('zE')),
  read: count((row) => row.classList.contains('yO')),
  peoplePerRow: [Math.min(...people.map((list) => list.length)), Math.max(...people.map((list) => list.length))],
  peopleWithName: people.flat().filter((span) => span.hasAttribute('name')).length + ' of ' + people.flat().length,
  ownerWords: mine.size,
  ownerWordShapes: [...mine].map(letters),
  ownerLast: count((row) => { const list = [...row.querySelectorAll('span[email]')]; return list.length && (list.at(-1).getAttribute('email') || '').toLowerCase() === me; }),
  counts: count((row) => row.querySelector('span.bx0')),
  drafts: count((row) => row.querySelector('.boq, span.sQ, font[color="#DD4B39"], .ag')),
  draftClassesSeen: ['boq', 'sQ', 'ag', 'aJ6'].filter((name) => main && main.querySelector('.' + name)),
  dates: count((row) => dateOf(row)),
  dateShapes: [...new Set(rows.slice(0, 50).map((row) => letters((dateOf(row) || { title: '' }).title)))].slice(0, 6),
  datesParse: count((row) => dateOf(row) && !Number.isNaN(Date.parse(dateOf(row).title.replace(/ /g, ' ')))),
  subjects: count((row) => row.querySelector('.bog')),
  snippets: count((row) => row.querySelector('.y2')),
  pager: pager ? letters(pager.textContent) : null,
  older: document.querySelectorAll('[act="20"], .amJ').length,
  hash: letters(location.hash.replace(/[^#/a-z_%:0-9]/gi, '?')).slice(0, 40),
};
