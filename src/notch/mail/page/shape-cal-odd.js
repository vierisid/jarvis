// The events of the week on screen that are not inside a day's column (the row
// of whole-day events): how the hidden line of each begins and ends. The end is
// the date as Google writes it, shown with every letter as "a" and every digit
// as "9"; the middle, where the title is, is only counted.
const lineOf = (chip) => [...chip.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent.includes(', ')).map((node) => node.textContent)[0] || '';
const mask = (text) => text.replace(/[A-Z]/g, 'A').replace(/[a-z]/g, 'a').replace(/\d/g, '9').replace(/[^Aa9 ,:–\-]/g, '?');
const chips = [...document.querySelectorAll('[data-eventchip]')].filter((chip) => !chip.closest('[data-datekey]'));
const row = chips[0] ? chips[0].parentElement : null;
const up = (node, levels) => { let at = node; const out = []; for (let n = 0; n < levels && at && at.parentElement; n++) { at = at.parentElement; out.push(at.tagName.toLowerCase() + (at.attributes.role ? '[' + at.attributes.role.value + ']' : '') + (at.hasAttribute('data-datekey') ? '[datekey]' : '') + ':' + at.children.length); } return out; };
const begins = chips.map((chip) => { const first = lineOf(chip).split(', ')[0]; return /^all day$/i.test(first) ? 'All day' : /^\d/.test(first) ? 'a time' : 'something else'; });
const ends = chips.map((chip) => mask(lineOf(chip).split(', ').slice(-2).join(', ')));
const boxes = chips.map((chip) => { const box = chip.getBoundingClientRect(); const cells = [...document.querySelectorAll('div[role="gridcell"][data-datekey]')].map((cell) => cell.getBoundingClientRect()); const over = cells.filter((cell) => box.left < cell.right - 2 && box.right > cell.left + 2).length; return { daysCovered: over, ofDays: cells.length }; });
return { wholeDay: chips.length, begins, ends, boxes, parents: chips[0] ? up(chips[0], 6) : null, moreLinks: document.querySelectorAll('[data-opens-more], [aria-label*=" more"]').length };
