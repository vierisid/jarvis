// Presses Send on the mail being written, once, and waits for Gmail to say it went.
// Refuses unless the mail is exactly the one expected: its subject is args.subject
// and it goes to args.to and to nobody else.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const subject = [...document.querySelectorAll('input[name="subjectbox"]')].find(visible);
const send = [...document.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^send\b/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
if (!subject || !send) return { sent: false, why: 'no mail is being written' };
if (subject.value !== args.subject) return { sent: false, why: 'not the mail that was expected' };
// Every address this mail would go to, wherever Gmail keeps them in the writing window.
const scope = subject.closest('form') || document;
const addressed = new Set();
for (const node of scope.querySelectorAll('[data-hovercard-id], [email], input[name="to"], input[name="cc"], input[name="bcc"]')) {
  for (const value of [node.getAttribute('data-hovercard-id'), node.getAttribute('email'), node.value]) {
    for (const found of String(value || '').match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []) addressed.add(found.toLowerCase());
  }
}
const want = String(args.to).toLowerCase();
if (addressed.size !== 1 || !addressed.has(want)) return { sent: false, why: 'it does not go to the one expected person', people: addressed.size };
const press = (node) => { for (const type of ['mousedown', 'mouseup', 'click']) node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); };
press(send);
let said = false;
for (let tries = 0; tries < 60 && !said; tries++) {
  await sleep(250);
  said = /message sent|your message has been sent/i.test(document.body.innerText || '');
}
return { sent: said, why: said ? '' : 'Gmail did not say it was sent', stillWriting: visible(subject) };
