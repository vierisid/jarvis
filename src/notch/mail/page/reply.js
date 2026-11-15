// One reply in the thread that is open, a step at a time (args.do):
//   "write"    start the reply (to everyone when it has people in copy), check who it
//              goes to, and write args.text into it. Gmail keeps it as a draft. Not sent.
//   "send"     press Send on the reply being written, once, and wait for Gmail to say it went.
//   "discard"  throw the reply being written away. Nothing is left in Drafts.
//
// Every step refuses unless the thread on screen is args.thread. "write" and "send"
// refuse unless the reply goes to exactly the people in args.to and args.cc, and to
// nobody else: who a reply goes to is decided before this script, never by it.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const press = (node) => { for (const type of ['mousedown', 'mouseup', 'click']) node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); };
const step = String(args && args.do || '');
const thread = String(args && args.thread || '').replace(/[^0-9a-f]/g, '');
if (thread.length !== 16 || ![...document.querySelectorAll(`h2[data-legacy-thread-id="${thread}"]`)].some(visible)) return { ok: false, why: 'the thread on screen is not the one meant' };

const editable = () => [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]')].find(visible) || null;
// The reply's own frame: the nearest thing above the text that also holds the fields a mail is
// sent with. Who it goes to is shown there, and nowhere else is looked at: the thread names many people.
const frameOf = (box) => {
  for (let at = box.parentElement, up = 0; at && up < 30; at = at.parentElement, up++) {
    if (at.querySelector('input[name="composeid"]')) return at.querySelector('[data-legacy-message-id]') ? null : at;
  }
  return null;
};
const me = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[10] === 'string' ? GLOBALS[10].toLowerCase() : '';
const expected = new Set([...(args.to || []), ...(args.cc || [])].map((address) => String(address).toLowerCase()));
const addressedIn = (frame) => {
  const found = new Set();
  for (const node of frame.querySelectorAll('[data-hovercard-id], [email], input[name="to"], input[name="cc"], input[name="bcc"]')) {
    for (const value of [node.getAttribute('data-hovercard-id'), node.getAttribute('email'), node.value]) {
      for (const address of String(value || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []) found.add(address.toLowerCase());
    }
  }
  // The owner's own address in their own reply is how Gmail shows who it is from: it is not someone the reply goes to,
  // unless the reply was meant to go to them.
  if (me && !expected.has(me)) found.delete(me);
  return found;
};
const goesToTheExpected = (frame) => {
  const found = addressedIn(frame);
  return expected.size > 0 && found.size === expected.size && [...expected].every((address) => found.has(address));
};

if (step === 'discard') {
  if (!editable()) return { ok: true, discarded: false, why: 'no reply is being written' };
  const bin = [...document.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^discard draft/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
  if (!bin) return { ok: false, why: 'no way to discard was found' };
  press(bin);
  for (let tries = 0; tries < 40 && editable(); tries++) await sleep(250);
  return editable() ? { ok: false, why: 'the reply is still there' } : { ok: true, discarded: true };
}

if (step === 'write') {
  let box = editable();
  if (!box) {
    // To everyone when there are people in copy, to the one who wrote otherwise. Gmail names the two buttons itself.
    const all = expected.size > 1;
    const button = [...document.querySelectorAll(all ? 'span.ams.bkG' : 'span.ams.bkH')].find(visible)
      || [...document.querySelectorAll('div[role="button"], span[role="link"]')].find((node) => visible(node) && (all ? /^reply (to )?all$/i : /^reply$/i).test((node.getAttribute('aria-label') || node.textContent || '').trim()));
    if (!button) return { ok: false, why: 'no way to reply was found' };
    press(button);
    for (let tries = 0; tries < 40 && !box; tries++) { await sleep(250); box = editable(); }
  }
  if (!box) return { ok: false, why: 'the reply did not open' };
  const frame = frameOf(box);
  if (!frame) return { ok: false, why: 'the frame of the reply was not found' };
  // Gmail fills in who it goes to a moment after the reply opens.
  for (let tries = 0; tries < 12 && !goesToTheExpected(frame); tries++) await sleep(250);
  if (!goesToTheExpected(frame)) return { ok: false, why: 'the reply does not go to exactly the expected people', people: addressedIn(frame).size, expected: expected.size };
  box.focus();
  // The caret at the very start, with nothing selected: text typed over a selection replaces it.
  const caret = document.createRange();
  caret.setStart(box, 0);
  caret.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(caret);
  const before = (box.innerText || '').replace(/\s+/g, ' ').trim().length;
  // Typed as text, never as markup, a line at a time: what is written is exactly the characters given.
  const lines = String(args.text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let at = 0; at < lines.length; at++) {
    if (lines[at]) document.execCommand('insertText', false, lines[at]);
    document.execCommand('insertLineBreak');
  }
  await sleep(300);
  const now = (box.innerText || '').replace(/\s+/g, ' ').trim();
  const wanted = String(args.text || '').replace(/\s+/g, ' ').trim();
  if (!wanted || !now.startsWith(wanted)) return { ok: false, why: 'what is in the reply is not what was written', before, after: now.length };
  // Gmail says so, in the frame or beside it, once it has kept the draft.
  let saved = false;
  for (let tries = 0; tries < 24 && !saved; tries++) { await sleep(250); saved = /draft saved|saved/i.test((frame.innerText || '').slice(-400)) || /draft saved/i.test(document.body.innerText || ''); }
  return { ok: true, written: true, saved, people: expected.size };
}

if (step === 'send') {
  const box = editable();
  const frame = box ? frameOf(box) : null;
  if (!box || !frame) return { ok: false, why: 'no reply is being written' };
  if (!goesToTheExpected(frame)) return { ok: false, why: 'the reply does not go to exactly the expected people', people: addressedIn(frame).size, expected: expected.size };
  const wanted = String(args.text || '').replace(/\s+/g, ' ').trim();
  if (!wanted || !(box.innerText || '').replace(/\s+/g, ' ').trim().startsWith(wanted)) return { ok: false, why: 'the reply is not the one that was shown' };
  const send = [...frame.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^send\b/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
  if (!send) return { ok: false, why: 'no way to send was found' };
  press(send);
  let said = false;
  for (let tries = 0; tries < 60 && !said; tries++) {
    await sleep(250);
    said = /message sent|your message has been sent/i.test(document.body.innerText || '') || !editable();
  }
  return said ? { ok: true, sent: true } : { ok: false, why: 'Gmail did not say it was sent', stillWriting: !!editable() };
}

return { ok: false, why: 'not a step of a reply' };
