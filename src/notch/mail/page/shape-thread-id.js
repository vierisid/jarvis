// Where an open thread says which thread it is (args.id: the id it should be).
// Tags, attribute names and yes or no. No mail, and no id but a yes or no about the one given.
const visible = (node) => !!node && node.offsetParent !== null;
const head = (node) => node.tagName.toLowerCase() + (node.attributes.role ? '[' + node.attributes.role.value + ']' : '');
const holders = [...document.querySelectorAll('[data-legacy-thread-id]')];
const perm = [...document.querySelectorAll('[data-thread-perm-id]')];
return {
  messages: [...document.querySelectorAll('[data-legacy-message-id]')].filter(visible).length,
  legacyThreadHolders: holders.map((node) => `${head(node)}:${visible(node) ? 'seen' : 'hidden'}:${node.getAttribute('data-legacy-thread-id') === String(args && args.id) ? 'the one asked for' : 'another'}`).slice(0, 8),
  permHolders: perm.map((node) => `${head(node)}:${visible(node) ? 'seen' : 'hidden'}`).slice(0, 8),
  replyButtons: [...document.querySelectorAll('span.ams')].filter(visible).map((node) => (node.className.includes('bkH') ? 'reply' : node.className.includes('bkG') ? 'reply all' : 'other')),
  hashShape: location.hash.split('/').map((part, at) => (at === 0 ? part : `<${part.length}>`)).join('/'),
};
