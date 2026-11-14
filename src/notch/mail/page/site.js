// Goes to another of Google's own sites in the same signed-in browser
// (args.site: "mail", "calendar" or "drive"; args.path: the path there, "/" by
// default) a moment after this script has answered. The desktop app throws
// away the answer of a script during which the address changed, so the change
// is made after the answer. Nothing but these three sites is ever opened.
const SITES = { mail: 'mail.google.com', calendar: 'calendar.google.com', drive: 'drive.google.com' };
const host = SITES[String(args && args.site)];
if (!host) throw new Error('not a site that is opened here');
const path = String((args && args.path) || '/');
if (!path.startsWith('/') || path.startsWith('//')) throw new Error('a path starts with one /');
const to = new URL(`https://${host}${path}`);
if (to.hostname !== host) throw new Error('not a site that is opened here');
if (location.href === to.href) return { there: true };
setTimeout(() => { location.href = to.href; }, 400);
return { there: false };
