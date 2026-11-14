// How the reply being written in the open thread holds who it goes to. Tags, classes, counts. No addresses.
const visible = (node) => !!node && node.offsetParent !== null;
const box = [...document.querySelectorAll('div[contenteditable="true"][role="textbox"], div.editable[contenteditable="true"]')].find(visible);
if (!box) return { open: false };
const me = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) ? String(GLOBALS[10] || '').toLowerCase() : '';
const name = (node) => node.tagName.toLowerCase() + (typeof node.className === 'string' && node.className.trim() ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
const holders = (scope) => [...scope.querySelectorAll('[data-hovercard-id], [email], input[name="to"], input[name="cc"], input[name="bcc"], [data-hovercard-owner-id]')].map((node) => {
  const value = node.getAttribute('data-hovercard-id') || node.getAttribute('email') || node.value || '';
  return `${name(node)}${node.name ? `[name=${node.name}]` : ''}:${/@/.test(value) ? (value.toLowerCase().includes(me) && me ? 'owner' : 'someone') : value ? 'no-address' : 'empty'}${visible(node) ? '' : ':hidden'}`;
});
const chain = [];
for (let at = box.parentElement; at && chain.length < 12; at = at.parentElement) chain.push(name(at));
// The nearest container above the text that also holds the fields a mail is sent with.
let around = null;
let depth = 0;
for (let at = box.parentElement; at && depth < 30; at = at.parentElement, depth++) {
  if (at.querySelector('input[name="to"], input[name="composeid"], input[name="subject"]')) { around = at; break; }
}
const form = box.closest('form');
return {
  open: true,
  chain,
  form: form ? { is: name(form), holders: holders(form).slice(0, 12), inputs: [...form.querySelectorAll('input')].map((input) => `${input.type}:${input.name || '-'}:${input.value ? 'set' : 'empty'}`).slice(0, 20) } : null,
  table: box.closest('table') ? holders(box.closest('table')).slice(0, 12) : null,
  text: (box.innerText || '').trim().length,
  around: around ? {
    is: name(around),
    levelsUp: depth,
    forms: [...around.querySelectorAll('form')].map((entry) => name(entry) + ':' + [...entry.querySelectorAll('input')].map((input) => `${input.name || '-'}=${/@/.test(input.value) ? (me && input.value.toLowerCase().includes(me) ? 'owner' : 'someone') : input.value ? 'set' : 'empty'}`).slice(0, 16).join(',')),
    holders: holders(around).slice(0, 16),
    editables: [...around.querySelectorAll('[contenteditable="true"]')].length,
    messagesInside: around.querySelectorAll('[data-legacy-message-id]').length,
  } : null,
};
