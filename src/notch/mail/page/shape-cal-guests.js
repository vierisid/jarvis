// How the events of the week on screen say whether other people are in them.
// The words counted are Google's own ("Accepted", "Needs RSVP"), never a title or a name.
const lineOf = (chip) => [...chip.querySelectorAll('*')].filter((node) => node.children.length === 0 && node.textContent.includes(', ')).map((node) => node.textContent)[0] || '';
const chips = [...document.querySelectorAll('[data-eventchip]')];
const WORDS = ['Accepted', 'Declined', 'Maybe', 'Needs RSVP', 'Tentative', 'Awaiting', 'Not responded', 'No response'];
const tally = {};
let none = 0;
const partsOfNone = {};
const partsOfSome = {};
for (const chip of chips) {
  const parts = lineOf(chip).split(', ');
  const found = WORDS.filter((word) => parts.includes(word));
  for (const word of found) tally[word] = (tally[word] || 0) + 1;
  const bucket = found.length ? partsOfSome : partsOfNone;
  bucket[parts.length] = (bucket[parts.length] || 0) + 1;
  if (!found.length) none++;
}
return { chips: chips.length, withAStatusWord: tally, withNone: none, partsWhenNone: partsOfNone, partsWhenSome: partsOfSome };
