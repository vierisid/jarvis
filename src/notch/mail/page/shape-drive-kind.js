// What Drive writes after a file's name in its label: the kind of file and a
// hint about keys. These are Google's words, not the owner's; they are still
// shown with every letter as "a" and every digit as "9". The name is cut off first.
const cells = [...document.querySelectorAll('div[role="gridcell"][data-id][aria-label]')].filter((node) => node.offsetParent !== null);
const nameOf = (cell) => { const tip = cell.querySelector('[data-id][data-tooltip]'); return tip ? tip.textContent.trim() : ''; };
const mask = (text) => text.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9');
const rests = cells.map((cell) => (cell.getAttribute('aria-label') || '').slice(nameOf(cell).length).trim());
const out = {};
for (const rest of rests) out[mask(rest)] = (out[mask(rest)] || 0) + 1;
// The words every label ends with, counted.
const words = rests.map((rest) => rest.split(/\s+/).reverse());
let common = 0;
while (words.length > 1 && words.every((list) => list[common] !== undefined && list[common] === words[0][common])) common++;
return { cells: cells.length, masked: out, wordsEveryLabelEndsWith: common };
