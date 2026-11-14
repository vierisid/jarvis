// Throws away the reply being written in the open thread. Nothing was sent, and nothing is left in Drafts.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (node) => !!node && node.offsetParent !== null;
const press = (node) => { for (const type of ['mousedown', 'mouseup', 'click']) node.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 })); };
const editable = () => [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]')].find(visible) || null;
if (!editable()) return { discarded: false, why: 'no reply is being written' };
const bin = [...document.querySelectorAll('div[role="button"]')].find((node) => visible(node) && /^discard draft/i.test(node.getAttribute('aria-label') || node.getAttribute('data-tooltip') || ''));
if (!bin) return { discarded: false, why: 'no way to discard was found' };
press(bin);
for (let tries = 0; tries < 40 && editable(); tries++) await sleep(250);
return { discarded: !editable() };
