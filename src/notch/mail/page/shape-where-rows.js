// Where the rows of the list sit in the page: how many there are, how many can be seen,
// and what their containers are called. Tags, classes and roles only.
const rows = [...document.querySelectorAll('tr.zA')];
const seen = rows.filter((row) => row.offsetParent !== null);
const chain = (node) => {
  const out = [];
  for (let at = node.parentElement; at && out.length < 14; at = at.parentElement) {
    const role = at.getAttribute('role');
    out.push(at.tagName.toLowerCase() + (typeof at.className === 'string' && at.className.trim() ? '.' + at.className.trim().split(/\s+/).slice(0, 3).join('.') : '') + (role ? `[role=${role}]` : ''));
  }
  return out;
};
return {
  rows: rows.length,
  seen: seen.length,
  roles: [...new Set([...document.querySelectorAll('[role]')].map((node) => node.getAttribute('role')))].slice(0, 30),
  mains: document.querySelectorAll('[role="main"]').length,
  chain: seen[0] ? chain(seen[0]) : rows[0] ? chain(rows[0]) : [],
  tables: [...document.querySelectorAll('table.F')].map((table) => (table.offsetParent !== null ? 'seen:' : 'hidden:') + table.querySelectorAll('tr.zA').length),
  loading: !!document.querySelector('.vX.UC, .v1'),
  none: [...document.querySelectorAll('td.TC')].filter((node) => node.offsetParent !== null).length,
};
