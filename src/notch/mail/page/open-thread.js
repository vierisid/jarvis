// Opens the thread args.id from the list on screen, the way a person does: by pressing its row.
// Gmail does not open a thread from its old id in the address once the mailbox is up.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const press = (node) => { for (const type of ['mousedown', 'mouseup', 'click']) node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); };
const open = () => [...document.querySelectorAll('[data-legacy-message-id]')].filter(visible).length;
if (open()) return { opened: true, already: true };
const row = [...document.querySelectorAll('tr.zA')].find((entry) => visible(entry) && entry.querySelector(`[data-legacy-thread-id="${String(args.id).replace(/[^0-9a-f]/g, '')}"]`));
if (!row) return { opened: false, why: 'that thread is not in the list on screen' };
// The subject is the part of a row that opens it; the box and the star at its left do other things.
press(row.querySelector('.bog') || row.querySelector('td.xY.a4W') || row);
let messages = 0;
for (let tries = 0; tries < 40 && !messages; tries++) { await sleep(250); messages = open(); }
return { opened: messages > 0, messages };
