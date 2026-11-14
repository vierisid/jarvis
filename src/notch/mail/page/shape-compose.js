// The state of the mail being written in Gmail's own writing window. Shapes only.
// With args.wait, waits up to that many milliseconds for Gmail to say the draft is saved.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const find = () => ({
  subject: [...document.querySelectorAll('input[name="subjectbox"]')].find(visible) || null,
  body: [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]')].find(visible) || null,
  send: [...document.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^send\b/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || '')) || null,
});
let parts = find();
for (let tries = 0; tries < 60 && !parts.body; tries++) { await sleep(250); parts = find(); }
const saved = () => /draft saved/i.test(document.body.innerText || '');
const until = Date.now() + ((args && args.wait) || 0);
while (!saved() && Date.now() < until) await sleep(300);
const form = parts.body ? parts.body.closest('form, [role="dialog"], table, body') : null;
return {
  subject: parts.subject ? parts.subject.value.length : null,
  body: parts.body ? (parts.body.innerText || '').trim().length : null,
  send: !!parts.send,
  // Who it goes to, as a count: Gmail shows each as a chip with the address in an attribute.
  to: document.querySelectorAll('[data-hovercard-id][role="option"], div[role="option"][data-name], span[email][peoplekit-id], [peoplekit-id] [data-hovercard-id]').length,
  toFields: [...document.querySelectorAll('input[peoplekit-id], textarea[name="to"], input[aria-label^="To"]')].filter(visible).length,
  saved: saved(),
  editables: [...document.querySelectorAll('[contenteditable="true"]')].filter(visible).length,
  inForm: !!form,
  hash: location.hash.replace(/[0-9a-f]{16}/gi, '<id>').replace(/[^#/?=&<>a-z_]/gi, '?').slice(0, 60),
  path: location.search ? location.search.replace(/=[^&]*/g, '=…').slice(0, 80) : '',
};
