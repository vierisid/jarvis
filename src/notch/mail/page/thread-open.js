// Is the thread args.id open on screen? Waits for it to be: Gmail was just
// loaded at the thread's own address. Answers { open }.
const visible = (node) => !!node && node.offsetParent !== null;
const id = String(args && args.id || '').replace(/[^0-9a-f]/g, '');
if (id.length !== 16) throw new Error('no thread id');
const until = Date.now() + ((args && args.wait) || 20000);
for (;;) {
  const title = [...document.querySelectorAll(`h2[data-legacy-thread-id="${id}"]`)].find(visible);
  const messages = [...document.querySelectorAll('[data-legacy-message-id]')].filter(visible).length;
  if (title && messages > 0) return { open: true, messages };
  if (Date.now() > until) return { open: false, another: [...document.querySelectorAll('h2[data-legacy-thread-id]')].some(visible) };
  await new Promise((resolve) => setTimeout(resolve, 250));
}
