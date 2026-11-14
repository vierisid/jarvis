// Where Gmail is, as a shape, and whether that is the place asked about (args.place).
const plain = (place) => { try { return decodeURIComponent(String(place).replace(/\+/g, ' ')); } catch { return String(place); } };
const letters = (text) => String(text || '').replace(/\p{Lu}/gu, 'A').replace(/\p{Ll}/gu, 'a').replace(/\d/g, '9');
const main = [...document.querySelectorAll('div[role="main"]')].find((node) => node.offsetParent !== null);
// The words of a search are the caller's own, not mail: the hash is shown as it is when it is a search this study made.
const mine = /^#search\/newer_than/.test(location.hash);
return {
  hash: mine ? location.hash.slice(0, 200) : letters(location.hash).slice(0, 80),
  same: args && args.place ? plain(location.hash) === plain(args.place) : null,
  mains: document.querySelectorAll('div[role="main"]').length,
  visibleMain: !!main,
  rows: main ? main.querySelectorAll('tr.zA').length : 0,
  none: main ? !!main.querySelector('td.TC') : false,
};
