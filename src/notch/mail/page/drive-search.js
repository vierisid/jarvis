// Reads the results of a search in Google Drive (".../drive/search?q=words&hl=en"),
// once the search for args.query is on screen. Answers with the files it shows,
// in Drive's own order: the closest first.
//
// A file says its name in a place of its own, and its label repeats the name,
// then the kind of file, then a hint about keys that is the same on every one.
if (location.hostname === 'accounts.google.com') return { state: 'signed-out' };
if (location.hostname !== 'drive.google.com') return { state: 'elsewhere' };
const query = String((args && args.query) || '');
const most = Math.min(Math.max(Number(args && args.most) || 8, 1), 20);
const cells = () => [...document.querySelectorAll('div[role="gridcell"][data-id][aria-label]')].filter((node) => node.offsetParent !== null);
const until = Date.now() + ((args && args.wait) || 12000);
let state = 'not-up';
for (;;) {
  const asked = new URL(location.href).searchParams.get('q') || '';
  const here = location.pathname.startsWith('/drive/search') && asked === query;
  if (here && cells().length > 0) { state = 'read'; break; }
  // Drive says so, in a place of its own, when a search found nothing.
  if (here && document.querySelector('[role="main"] [role="status"]')) { state = 'read'; break; }
  if (Date.now() > until) { state = here ? 'not-up' : 'another-search'; break; }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (state !== 'read') return { state };
// A moment for the list to fill.
await new Promise((resolve) => setTimeout(resolve, 600));
const files = [];
for (const cell of cells().slice(0, most)) {
  const own = cell.querySelector('[data-id][data-tooltip]');
  const name = own ? own.textContent.trim() : '';
  const label = cell.getAttribute('aria-label') || '';
  const id = cell.dataset.id || '';
  if (!name || !/^[A-Za-z0-9_-]{20,}$/.test(id)) continue;
  const rest = label.startsWith(name) ? label.slice(name.length).trim() : '';
  files.push({ id, name: name.slice(0, 200), kind: rest.replace(/\s*\S+ \S+ \(\S+ \+ \S+\)$/, '').slice(0, 60) });
}
return { state: 'read', files, shown: cells().length };
