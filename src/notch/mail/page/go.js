// Goes to a place inside Gmail (args.place, like "#inbox" or "#search/newer_than%3A30d/p2")
// a moment after this script has answered. The desktop app throws away the
// answer of a script during which the address changed, so the change is made
// after the answer, and wait-list.js is what waits for it.
const place = String(args && args.place || '#inbox');
if (!place.startsWith('#')) throw new Error('a place inside Gmail starts with #');
if (location.hostname !== 'mail.google.com') throw new Error('this is not Gmail');
if (location.hash === place) return { there: true };
setTimeout(() => { location.hash = place; }, 400);
return { there: false };
