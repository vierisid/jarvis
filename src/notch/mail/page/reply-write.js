// In the thread that is open, starts a reply and writes args.text into it. Nothing is sent.
// Refuses unless the reply goes to args.to and to nobody else.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const press = (node) => { for (const type of ['mousedown', 'mouseup', 'click']) node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); };
const editable = () => [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]')].find(visible) || null;
let box = editable();
if (!box) {
  const reply = [...document.querySelectorAll('span.ams.bkH, div[role="button"][aria-label="Reply"], span[role="link"]')].find((node) => visible(node) && /^reply$/i.test((node.getAttribute('aria-label') || node.textContent || '').trim()));
  if (!reply) return { written: false, why: 'no way to reply was found' };
  press(reply);
  for (let tries = 0; tries < 40 && !box; tries++) { await sleep(250); box = editable(); }
}
if (!box) return { written: false, why: 'the reply did not open' };
// args.open: only open the reply, write nothing (for looking at how it is built).
if (args.open) return { written: false, opened: true };
// The reply's own frame: the nearest thing above the text that also holds the fields a mail is sent with.
// Who it goes to is shown there, and nowhere else is looked at: the thread above it names many people.
let scope = null;
for (let at = box.parentElement, up = 0; at && up < 30; at = at.parentElement, up++) {
  if (at.querySelector('input[name="composeid"]')) { scope = at; break; }
}
if (!scope || scope.querySelector('[data-legacy-message-id]')) return { written: false, why: 'the frame of the reply was not found' };
const addressed = new Set();
for (const node of scope.querySelectorAll('[data-hovercard-id], [email], input[name="to"], input[name="cc"], input[name="bcc"]')) {
  for (const value of [node.getAttribute('data-hovercard-id'), node.getAttribute('email'), node.value]) {
    for (const found of String(value || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []) addressed.add(found.toLowerCase());
  }
}
if (addressed.size !== 1 || !addressed.has(String(args.to).toLowerCase())) return { written: false, why: 'the reply does not go to the one expected person', people: addressed.size };
box.focus();
// The caret is put at the very start, with nothing selected: text typed over a selection replaces it,
// and what Gmail has already put in the reply (a signature) must stay whole, under what is written.
const caret = document.createRange();
caret.setStart(box, 0);
caret.collapse(true);
const selection = getSelection();
selection.removeAllRanges();
selection.addRange(caret);
const before = (box.innerText || '').trim().length;
// Typed as text, never as markup: what is written is exactly the characters given.
document.execCommand('insertText', false, String(args.text));
await sleep(400);
const after = (box.innerText || '').trim().length;
return { written: after >= before + String(args.text).trim().length, before, after, people: addressed.size };
