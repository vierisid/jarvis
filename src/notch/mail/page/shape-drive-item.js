// How a file in Drive's list says its name and its kind: which part repeats
// which, as counts. No name, no kind, no id.
const cells = [...document.querySelectorAll('div[role="gridcell"][data-id][aria-label]')].filter((node) => node.offsetParent !== null);
const tally = (list) => { const out = {}; for (const item of list) out[item] = (out[item] || 0) + 1; return out; };
const nameOf = (cell) => { const tip = cell.querySelector('[data-id][data-tooltip]'); return tip ? tip.textContent.trim() : ''; };
const label = (cell) => cell.getAttribute('aria-label') || '';
const tip = (cell) => { const node = cell.querySelector('[data-id][data-tooltip]'); return node ? node.getAttribute('data-tooltip') || '' : ''; };
const q = new URL(location.href).searchParams.get('q') || '';
return {
  cells: cells.length,
  named: cells.filter((cell) => nameOf(cell).length > 0).length,
  labelStartsWithName: cells.filter((cell) => nameOf(cell) && label(cell).startsWith(nameOf(cell))).length,
  labelIsNameOnly: cells.filter((cell) => label(cell) === nameOf(cell)).length,
  wordsAfterNameInLabel: tally(cells.map((cell) => { const rest = label(cell).startsWith(nameOf(cell)) ? label(cell).slice(nameOf(cell).length).trim() : null; return rest === null ? 'label does not start with the name' : String(rest ? rest.split(/\s+/).length : 0); })),
  tipIsName: cells.filter((cell) => tip(cell) === nameOf(cell)).length,
  tipEndsWithName: cells.filter((cell) => tip(cell) !== nameOf(cell) && tip(cell).endsWith(nameOf(cell))).length,
  tipHasColonBeforeName: cells.filter((cell) => tip(cell).endsWith(': ' + nameOf(cell))).length,
  distinctKindsAfterName: new Set(cells.map((cell) => label(cell).slice(nameOf(cell).length).trim())).size,
  searchBoxHoldsTheQuery: [...document.querySelectorAll('input[type="text"], input[aria-label]')].some((box) => box.value === q) ,
  emptySigns: { status: document.querySelectorAll('[role="main"] [role="status"]').length, headings: document.querySelectorAll('[role="main"] [role="heading"]').length, images: document.querySelectorAll('[role="main"] img').length, progress: document.querySelectorAll('[role="progressbar"]').length },
  mainTextLength: (document.querySelector('[role="main"]') || document.body).textContent.length > 0,
};
