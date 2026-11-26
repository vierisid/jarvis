// One reply in the thread that is open, a step at a time (args.do):
//   "write"    start the reply (to everyone when it has people in copy), check who it
//              goes to, and write args.text into it. Gmail keeps it as a draft. Not sent.
//   "send"     press Send on the reply being written, once, and wait for Gmail to say it went.
//              The answer says whether Send was pressed (`pressed`) and whether Gmail said,
//              after the press, that it went (`ok`).
//   "discard"  throw the reply being written away. Nothing is left in Drafts. Only the reply
//              "write" opened and marked is thrown away, whatever it holds: any other is
//              somebody's, and it is left where it is.
//
// A reply that is already open when "write" begins was not opened here: it is the owner's
// draft, or an earlier one that did not go. It is answered before anything else is looked
// at, who it goes to included, and nothing is written into it.
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
// What somebody wrote in a reply: its text without the signature and without the mail it answers,
// which Gmail puts there by itself.
const written = (box) => {
  const copy = box.cloneNode(true);
  for (const node of copy.querySelectorAll('.gmail_signature, [data-smartmail="gmail_signature"], .gmail_signature_prefix, .gmail_quote, .gmail_quote_container, .gmail_attr, .gmail_extra, blockquote')) node.remove();
  return (copy.textContent || '').replace(/[\s\u00a0\u200b]+/g, ' ').trim();
};
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

// The words of this refusal are MAIL_WHY_DRAFT_THERE in ../mailbox.ts: the draft is then left alone.
const DRAFT_THERE = 'a reply is already being written in that thread';
const flat = (text) => String(text || '').replace(/\s+/g, ' ').trim();
// The mark "write" leaves on the reply it opened, on its text: "discard" runs in
// the same page later and has to know that reply from one somebody else began. It is gone with
// the page: a reply of ours left from an earlier visit is then nobody's to throw away, and stays.
const MARK = 'data-jarvis-reply';
// Only the text itself carries it: a frame can outlive the reply it held, and a mark on it would
// make whatever is opened in it next look like ours.
const ours = (box) => box.getAttribute(MARK) === thread;
// Gmail's own word that a mail went, counted: in the places it speaks through, and on the whole
// page. Only a count that goes up after Send was pressed is Gmail saying so about this mail. A
// mail in the thread that says "your message has been sent" was there before.
const heard = () => {
  const count = (text) => (String(text || '').match(/message sent|your message has been sent/gi) || []).length;
  return {
    live: count([...document.querySelectorAll('[role="alert"], [aria-live]')].map((node) => node.innerText || node.textContent || '').join('\n')),
    all: count(document.body.innerText),
  };
};

if (step === 'discard') {
  const box = editable();
  if (!box) return { ok: true, discarded: false, why: 'no reply is being written' };
  const frame = frameOf(box);
  if (!frame) return { ok: false, why: 'the frame of the reply was not found' };
  // Only the reply that "write" opened is thrown away, and that one whatever it holds: a write
  // that went wrong half way leaves words that are not the ones meant, and they must not stay
  // to block the thread. A reply without the mark is somebody's (the owner's own, half
  // written, or one that begins with our words and goes on with theirs): it used to be thrown
  // away with the rest when a step before this one failed.
  if (!ours(box)) return { ok: false, why: 'the reply being written is not the one that was written here', kept: true };
  // The bin of this reply, and of no other: a thread can hold more than one thing with a bin.
  const bin = [...frame.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^discard draft/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
  if (!bin) return { ok: false, why: 'no way to discard was found' };
  press(bin);
  const there = () => document.contains(box) && visible(box);
  for (let tries = 0; tries < 40 && there(); tries++) await sleep(250);
  return there() ? { ok: false, why: 'the reply is still there' } : { ok: true, discarded: true };
}

if (step === 'write') {
  // A reply that is open before Reply is pressed is somebody's draft: the owner's own, half
  // written, or an earlier one of these that could not be sent. This comes before who it
  // goes to: a draft whose people the owner had changed was answered "not the expected
  // people", and whoever asked then threw it away.
  const before = editable();
  if (before) return { ok: false, why: DRAFT_THERE };
  // To everyone when there are people in copy, to the one who wrote otherwise. Gmail names the two buttons itself.
  const all = expected.size > 1;
  const button = [...document.querySelectorAll(all ? 'span.ams.bkG' : 'span.ams.bkH')].find(visible)
    || [...document.querySelectorAll('div[role="button"], span[role="link"]')].find((node) => visible(node) && (all ? /^reply (to )?all$/i : /^reply$/i).test((node.getAttribute('aria-label') || node.textContent || '').trim()));
  if (!button) return { ok: false, why: 'no way to reply was found' };
  press(button);
  let box = null;
  for (let tries = 0; tries < 40 && !box; tries++) { await sleep(250); box = editable(); }
  if (!box) return { ok: false, why: 'the reply did not open' };
  const frame = frameOf(box);
  if (!frame) return { ok: false, why: 'the frame of the reply was not found' };
  // Pressing Reply can bring up a draft Gmail had kept for the thread. Words in it are
  // somebody's: nothing is written into it. Written at its start, the new words went out with
  // the old ones after them: the same text twice in one mail, or the owner's unfinished
  // sentence sent in their name. Asked before who it goes to, for the reason above.
  const already = written(box);
  if (already) return { ok: false, why: DRAFT_THERE };
  // A reply this script opened, with no words in it: it is marked as the one "discard" may
  // throw away, before anything is written, so that a write that fails half way is not left.
  box.setAttribute(MARK, thread);
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
  const was = flat(box.innerText).length;
  // Typed as text, never as markup, a line at a time: what is written is exactly the characters given.
  const lines = String(args.text || '').replace(/\r\n?/g, '\n').split('\n');
  for (let at = 0; at < lines.length; at++) {
    if (lines[at]) document.execCommand('insertText', false, lines[at]);
    document.execCommand('insertLineBreak');
  }
  await sleep(300);
  const now = flat(box.innerText);
  const wanted = flat(args.text);
  if (!wanted || !now.startsWith(wanted)) return { ok: false, why: 'what is in the reply is not what was written', before: was, after: now.length };
  // Gmail says so, in the frame or beside it, once it has kept the draft.
  let saved = false;
  for (let tries = 0; tries < 16 && !saved; tries++) { await sleep(250); saved = /draft saved/i.test(document.body.innerText || ''); }
  return { ok: true, written: true, saved, people: expected.size };
}

if (step === 'send') {
  const box = editable();
  const frame = box ? frameOf(box) : null;
  // `pressed` is in every answer: whoever asked has to know whether the mail may be on its way.
  if (!box || !frame) return { ok: false, why: 'no reply is being written', pressed: false };
  if (!goesToTheExpected(frame)) return { ok: false, why: 'the reply does not go to exactly the expected people', pressed: false, people: addressedIn(frame).size, expected: expected.size };
  const wanted = flat(args.text);
  if (!wanted || !flat(box.innerText).startsWith(wanted)) return { ok: false, why: 'the reply is not the one that was shown', pressed: false };
  const send = [...frame.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^send\b/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
  if (!send) return { ok: false, why: 'no way to send was found', pressed: false };
  const was = heard();
  press(send);
  const open = () => document.contains(box) && visible(box);
  let said = false;
  // The reply closing is not Gmail saying it went: it closes when it is thrown away too, and
  // Gmail closes it at once on Send, before it says anything. The words are waited for in full.
  for (let tries = 0; tries < 60 && !said; tries++) {
    await sleep(250);
    const now = heard();
    said = now.live > was.live || now.all > was.all;
  }
  // Yes: Gmail said, after the press, that it went. No, with `pressed`: it may have gone all the
  // same, and whoever asked looks in the thread (../mailbox.ts, `sent`).
  return said ? { ok: true, pressed: true, said: true, closed: !open() } : { ok: false, why: 'Gmail did not say it was sent', pressed: true, said: false, closed: !open() };
}

return { ok: false, why: 'not a step of a reply' };
