// Is Gmail up in this tab? Answers { up }: on Gmail, with the mailbox loaded.
// Nothing of the mailbox is in the answer.
return {
  up: location.hostname === 'mail.google.com'
    && typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) && typeof GLOBALS[9] === 'string'
    && !!document.querySelector('div[role="main"]'),
};
