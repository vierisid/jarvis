// Presses Send on the mail being written, once, and waits for Gmail to say it went.
// The answer says whether Send was pressed (`pressed`): a refusal before that sent nothing.
// Refuses unless the mail is exactly the one expected: its subject is args.subject
// and it goes to args.to and to nobody else. args.to is one address, or a list
// of them: then it goes to exactly those people.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const subject = [...document.querySelectorAll('input[name="subjectbox"]')].find(visible);
const send = [...document.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^send\b/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
if (!subject || !send) return { sent: false, pressed: false, why: 'no mail is being written' };
if (subject.value !== args.subject) return { sent: false, pressed: false, why: 'not the mail that was expected' };
// Every address this mail would go to, wherever Gmail keeps them in the writing window.
const scope = subject.closest('form') || document;
const addressed = new Set();
for (const node of scope.querySelectorAll('[data-hovercard-id], [email], input[name="to"], input[name="cc"], input[name="bcc"]')) {
  for (const value of [node.getAttribute('data-hovercard-id'), node.getAttribute('email'), node.value]) {
    for (const found of String(value || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []) addressed.add(found.toLowerCase());
  }
}
const want = new Set((Array.isArray(args.to) ? args.to : [args.to]).map((one) => String(one).toLowerCase()));
if (want.size === 0 || addressed.size !== want.size || [...want].some((one) => !addressed.has(one))) {
  return { sent: false, pressed: false, why: want.size > 1 ? 'it does not go to exactly the expected people' : 'it does not go to the one expected person', people: addressed.size };
}
const press = (node) => { for (const type of ['mousedown', 'mouseup', 'click']) node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); };
// Gmail's own word that a mail went, counted: in the places it speaks through, and on the whole
// page. Only a count that goes up after Send was pressed is Gmail saying so about this mail: a
// mail that itself says "message sent" said so before.
const heard = () => {
  const count = (text) => (String(text || '').match(/message sent|your message has been sent/gi) || []).length;
  return {
    live: count([...document.querySelectorAll('[role="alert"], [aria-live]')].map((node) => node.innerText || node.textContent || '').join('\n')),
    all: count(document.body.innerText),
  };
};
const was = heard();
press(send);
let said = false;
for (let tries = 0; tries < 60 && !said; tries++) {
  await sleep(250);
  const now = heard();
  said = now.live > was.live || now.all > was.all;
}
// `pressed`: from here on the mail may be on its way, whatever Gmail says. When Gmail says
// nothing, the Sent folder is asked (../mailbox.ts).
return { sent: said, pressed: true, why: said ? '' : 'Gmail did not say it was sent', stillWriting: visible(subject) };
