// Whose mailbox this is: the address Gmail itself gives for the signed-in account.
const address = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[10] === 'string' ? GLOBALS[10] : '';
if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error('the page does not say whose mailbox this is');
return { address: address.toLowerCase() };
