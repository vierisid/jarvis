// One reply in the thread that is open, a step at a time (args.do):
//   "write"    start the reply (to everyone when it has people in copy), check who it
//              goes to, and write args.text into it. Gmail keeps it as a draft. Not sent.
//   "send"     press Send on the reply being written, once, and wait for Gmail to say it went.
//              The answer says whether Send was pressed (`pressed`) and whether Gmail said so
//              (`ok`). Neither is "sent": that is asked of the thread afterwards.
//   "discard"  throw the reply being written away. Nothing is left in Drafts. Only a reply
//              that holds args.text, or no words at all, is thrown away: anything else is
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

if (step === 'discard') {
  const box = editable();
  if (!box) return { ok: true, discarded: false, why: 'no reply is being written' };
  const frame = frameOf(box);
  if (!frame) return { ok: false, why: 'the frame of the reply was not found' };
  // Only what was written here is thrown away, or a reply with no words in it. A reply that
  // holds other words is somebody's draft (the owner's own, half written): it used to be
  // thrown away with the rest when a step before this one failed.
  const wanted = flat(args.text);
  const ours = !!wanted && flat(box.innerText).startsWith(wanted);
  if (!ours && written(box)) return { ok: false, why: 'the reply being written is not the one that was written here', kept: true };
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
  if (before) return { ok: false, why: DRAFT_THERE, opened: false, held: written(before).length };
  // To everyone when there are people in copy, to the one who wrote otherwise. Gmail names the two buttons itself.
  const all = expected.size > 1;
  const button = [...document.querySelectorAll(all ? 'span.ams.bkG' : 'span.ams.bkH')].find(visible)
    || [...document.querySelectorAll('div[role="button"], span[role="link"]')].find((node) => visible(node) && (all ? /^reply (to )?all$/i : /^reply$/i).test((node.getAttribute('aria-label') || node.textContent || '').trim()));
  if (!button) return { ok: false, why: 'no way to reply was found', opened: false };
  press(button);
  let box = null;
  for (let tries = 0; tries < 40 && !box; tries++) { await sleep(250); box = editable(); }
  if (!box) return { ok: false, why: 'the reply did not open', opened: false };
  // From here on a reply is open that was not before: `opened` says so, whatever else is answered.
  const frame = frameOf(box);
  if (!frame) return { ok: false, why: 'the frame of the reply was not found', opened: true };
  // Pressing Reply can bring up a draft Gmail had kept for the thread. Words in it are
  // somebody's: nothing is written into it. Written at its start, the new words went out with
  // the old ones after them: the same text twice in one mail, or the owner's unfinished
  // sentence sent in their name. Asked before who it goes to, for the reason above.
  const already = written(box);
  if (already) return { ok: false, why: DRAFT_THERE, opened: true, held: already.length };
  // Gmail fills in who it goes to a moment after the reply opens.
  for (let tries = 0; tries < 12 && !goesToTheExpected(frame); tries++) await sleep(250);
  if (!goesToTheExpected(frame)) return { ok: false, why: 'the reply does not go to exactly the expected people', opened: true, people: addressedIn(frame).size, expected: expected.size };
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
  if (!wanted || !now.startsWith(wanted)) return { ok: false, why: 'what is in the reply is not what was written', opened: true, before: was, after: now.length };
  // Gmail says so, in the frame or beside it, once it has kept the draft.
  let saved = false;
  for (let tries = 0; tries < 16 && !saved; tries++) { await sleep(250); saved = /draft saved/i.test(document.body.innerText || ''); }
  return { ok: true, written: true, opened: true, saved, people: expected.size };
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
  // Gmail's own words, and only when they were not on the page before Send was pressed: a mail in
  // the thread that says "your message has been sent" is not Gmail saying so about this one.
  const says = () => /message sent|your message has been sent/i.test(document.body.innerText || '');
  const stale = says();
  press(send);
  const open = () => document.contains(box) && visible(box);
  let said = false;
  // The reply closing is not Gmail saying it went: it closes when it is thrown away too. Once it
  // has closed, the words are waited for a little longer and no more.
  for (let tries = 0, shut = 0; tries < 60 && !said && shut < 8; tries++) {
    await sleep(250);
    said = !stale && says();
    if (!open()) shut++;
  }
  // Not "sent": Gmail said so, or did not. Whether it went is asked of the thread (../mailbox.ts, `sent`).
  return said ? { ok: true, pressed: true, said: true, closed: !open() } : { ok: false, why: 'Gmail did not say it was sent', pressed: true, said: false, closed: !open() };
}

return { ok: false, why: 'not a step of a reply' };
