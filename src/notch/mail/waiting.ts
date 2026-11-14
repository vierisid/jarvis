/**
 * Is a person waiting for the owner in this thread?
 *
 * This is the rule behind "You have not replied to Marco". It reads the
 * state of the thread, not whether it was opened: who wrote last, to whom,
 * how long ago, and whether the owner has already begun an answer.
 *
 * It is the cheap half. It never calls a model: it rules out what plainly is
 * not a person waiting, so that only the rest is read by one. Whether a
 * message from a person needs an answer at all ("thanks, got it") is the
 * model's half (./proposer.ts).
 */
import { isOwner, type MailMessage, type MailOwner, type MailPerson, type MailThread } from './thread.ts';

/** How long a message waits before it is anyone's business: the owner may be about to answer. */
export const MAIL_WAIT_MIN_MS = 4 * 60 * 60 * 1000;
/** Past this, a thread is left alone: bringing up a two-month-old mail is not help. */
export const MAIL_WAIT_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** A message sent to more people than this, in a thread the owner never wrote in, is a round robin. */
export const MAIL_CROWD = 6;

export type MailWaiting =
  | { waits: true; who: MailPerson; since: number; last: MailMessage }
  | { waits: false; why: 'empty' | 'owner-last' | 'draft' | 'machine' | 'filed' | 'not-addressed' | 'crowd' | 'too-new' | 'too-old' };

/**
 * Addresses nobody reads the replies to. The part before the at sign, as a
 * whole or up to a separator: "noreply", "no-reply+abc", "notifications.x".
 */
const MACHINE_LOCAL = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|not?[-_.]?respond(?:er)?|mailer[-_.]?daemon|postmaster|bounces?|notifications?|notify|alerts?|newsletters?|digest|mailer|automated|auto[-_.]?(?:reply|confirm|mailer)|calendar[-_.]?notification|invitations?|receipts?|invoices?|statements?|billing[-_.]?noreply|unsubscribe)(?:$|[-_.+])/;
/** The same, anywhere in the part before the at sign. */
const MACHINE_LOCAL_ANYWHERE = /no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon/;
/**
 * Addresses that may be a person or a machine: "hello@" at a company of five
 * is its founder, and at a company of five thousand it is a newsletter. They
 * count as a person only in a conversation the owner has written in.
 */
const SHARED_LOCAL = /^(?:info|hello|hi|team|support|help|helpdesk|service|sales|contact|office|admin|accounts?|billing|orders?|news|updates?|marketing|press|careers?|jobs|hr|feedback|community|events?|members?|customer[-_.]?(?:service|care|success)|success|security|legal|privacy|system|bot|robot)(?:$|[-_.+])/;
/** Hosts that only ever send by machine. */
const MACHINE_HOST = /(?:^|\.)(?:calendar\.google\.com|docs\.google\.com|googlegroups\.com|bounce\.[a-z0-9.-]+|mailchimp(?:app)?\.[a-z]+|mcsv\.net|sendgrid\.(?:net|com)|amazonses\.com|mailgun\.org|facebookmail\.com|linkedin\.com|github\.com|notion\.so|slack\.com|atlassian\.net|intercom-mail\.com|substack\.com|medium\.com)$/;

/** A sender that is plainly a machine or a mailing. */
export function mailMachine(person: MailPerson): boolean {
  const [local = '', host = ''] = person.address.split('@');
  if (MACHINE_LOCAL.test(local) || MACHINE_LOCAL_ANYWHERE.test(local) || MACHINE_HOST.test(host)) return true;
  // "Sam via LinkedIn", "Anna (via Google Docs)": a service writing in a person's name.
  return /(?:^|[\s(])via\s+\S/i.test(person.name);
}

/** A sender that may be either: a shared address. */
export function mailShared(person: MailPerson): boolean {
  return SHARED_LOCAL.test(person.address.split('@')[0] ?? '');
}

export function mailWaiting(thread: MailThread, owner: MailOwner, now: number): MailWaiting {
  const last = thread.messages.at(-1);
  if (!last) return { waits: false, why: 'empty' };
  if (isOwner(last.from, owner)) return { waits: false, why: 'owner-last' };
  // They have begun an answer: it is theirs to finish, not Jarvis's to write over.
  if (thread.draft) return { waits: false, why: 'draft' };
  if (mailMachine(last.from)) return { waits: false, why: 'machine' };

  const ownerWrote = thread.messages.some((message) => isOwner(message.from, owner));
  // A mailing Gmail filed away, or a shared address, is a person only when
  // the owner has been writing with them in this thread.
  if (!ownerWrote && (thread.filed === 'promotions' || thread.filed === 'social' || thread.filed === 'forums')) return { waits: false, why: 'filed' };
  if (!ownerWrote && mailShared(last.from)) return { waits: false, why: 'machine' };

  // Written to the owner, not copied to them. A thread they are part of
  // stays theirs when a reply-all moves them to the copy line.
  const addressed = last.to.some((person) => isOwner(person, owner));
  const copied = last.cc.some((person) => isOwner(person, owner));
  if (!addressed && !(ownerWrote && copied)) return { waits: false, why: 'not-addressed' };
  if (!ownerWrote && last.to.length + last.cc.length > MAIL_CROWD) return { waits: false, why: 'crowd' };

  const waited = now - last.at;
  if (waited < MAIL_WAIT_MIN_MS) return { waits: false, why: 'too-new' };
  if (waited > MAIL_WAIT_MAX_MS) return { waits: false, why: 'too-old' };
  return { waits: true, who: last.from, since: last.at, last };
}

/**
 * Who a reply goes to, decided here and never by a model: the one who wrote
 * last, and in copy everyone else that message was written or copied to,
 * without the owner.
 */
export function mailReplyTo(last: MailMessage, owner: MailOwner): { to: MailPerson[]; cc: MailPerson[] } {
  const seen = new Set<string>([last.from.address]);
  const cc: MailPerson[] = [];
  for (const person of [...last.to, ...last.cc]) {
    if (isOwner(person, owner) || seen.has(person.address)) continue;
    seen.add(person.address);
    cc.push(person);
  }
  return { to: [last.from], cc };
}
