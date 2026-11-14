// The threads in the list Gmail is showing, once it shows the place asked for
// (args.place) and is no longer the list that was there before (args.not: the
// first thread of the page before). Answers { there, rows }.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (place) => { try { return decodeURIComponent(String(place).replace(/\+/g, ' ')); } catch { return String(place); } };
const wanted = plain(args.place);
const idOf = (row) => { const node = row.querySelector('[data-legacy-thread-id]'); return node ? node.getAttribute('data-legacy-thread-id') || '' : ''; };
const started = Date.now();
let rows = [];
let seen = '';
let settled = 0;
let there = false;
while (Date.now() - started < 20000) {
  await sleep(250);
  if (plain(location.hash) !== wanted) continue;
  // Gmail keeps the lists it has shown: the one in view is the one that takes up room.
  const main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null);
  if (!main) continue;
  rows = [...main.querySelectorAll('tr.zA')];
  const first = rows.length ? idOf(rows[0]) : '';
  // Still the page before: wait for it to change. Past the last page Gmail shows the
  // last one again, so after a while the same rows are the answer.
  if (rows.length && args.not && first === args.not && Date.now() - started < 6000) continue;
  // No rows is an answer only once Gmail says there are none (its "no messages" line).
  if (!rows.length && !main.querySelector('td.TC') && Date.now() - started < 8000) continue;
  const now = first + ':' + rows.length;
  settled = now === seen ? settled + 1 : 0;
  seen = now;
  if (settled >= 2) { there = true; break; }
}
return {
  there,
  rows: there ? rows.map((row) => ({
    id: idOf(row),
    people: [...row.querySelectorAll('span[email]')].map((span) => ({ name: span.getAttribute('name') || span.textContent || '', address: span.getAttribute('email') || '' })),
    count: Number((row.querySelector('span.bx0') || { textContent: '1' }).textContent) || 1,
    draft: !!row.querySelector('.boq'),
    subject: (row.querySelector('.bog') || { textContent: '' }).textContent || '',
  })) : [],
};
