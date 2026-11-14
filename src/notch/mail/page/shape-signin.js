// Is this browser signed in to Gmail? Shapes only: no address, no name, no mail.
// Run after going to https://mail.google.com/mail/u/0/. A browser that is not
// signed in is sent to Google's sign-in page or to the page that advertises Gmail.
const host = location.hostname === 'mail.google.com' ? 'mail'
  : location.hostname === 'accounts.google.com' ? 'sign-in'
  : location.hostname.endsWith('.google.com') ? 'google-other' : 'other';
const wait = async (found, ms) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = found();
    if (value || Date.now() > until) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};
// The list of threads is the sign that the mail itself is up.
const main = host === 'mail' ? await wait(() => document.querySelector('div[role="main"]'), 15000) : null;
const globals = typeof GLOBALS !== 'undefined' && Array.isArray(GLOBALS) ? GLOBALS : null;
return {
  host,
  path: location.pathname.split('/').slice(0, 4).map((part) => (/^\d+$/.test(part) ? '#' : part)).join('/'),
  main: !!main,
  rows: main ? main.querySelectorAll('tr.zA').length : 0,
  rowsWithThread: main ? main.querySelectorAll('tr.zA [data-legacy-thread-id]').length : 0,
  globals: !!globals,
  key: globals ? (typeof globals[9] === 'string' ? `text of ${globals[9].length}, hex ${/^[0-9a-f]+$/.test(globals[9])}` : typeof globals[9]) : null,
  me: globals ? (typeof globals[10] === 'string' && /^[^@\s]+@[^@\s]+$/.test(globals[10]) ? 'an address' : typeof globals[10]) : null,
  accounts: document.querySelectorAll('a[href*="SignOutOptions"], a[aria-label*="@"]').length,
  visible: document.visibilityState,
};
