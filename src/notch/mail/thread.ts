/**
 * A mail thread as the notch's mail layer knows it, wherever it was read
 * from. Today that is Gmail in Jarvis's own browser (./gmail.ts).
 */

export interface MailPerson {
  /** The name they show, or '' when the mail gave none. */
  name: string;
  /** Their address, lower case. */
  address: string;
}

export interface MailMessage {
  from: MailPerson;
  to: MailPerson[];
  cc: MailPerson[];
  /** When it was sent, in milliseconds. */
  at: number;
  /** What it says, as plain text, without the history quoted under it. */
  text: string;
}

export interface MailThread {
  id: string;
  subject: string;
  /** Oldest first. Drafts are not messages. */
  messages: MailMessage[];
  /** The owner has an unsent draft in this thread. */
  draft?: boolean;
  /** Gmail filed it under promotions, social, updates or forums. */
  filed?: 'promotions' | 'social' | 'updates' | 'forums';
}

/** The addresses the owner writes from. Lower case. */
export type MailOwner = ReadonlySet<string>;

export function mailPerson(name: string, address: string): MailPerson {
  return { name: name.trim().replace(/^["']+|["']+$/g, '').trim(), address: address.trim().toLowerCase() };
}

export const isOwner = (person: MailPerson, owner: MailOwner): boolean => owner.has(person.address);

/** The thread as it stood at a moment: what had arrived by then, and nothing after. */
export function threadAsOf(thread: MailThread, at: number): MailThread {
  const messages = thread.messages.filter((message) => message.at <= at);
  return messages.length === thread.messages.length ? thread : { ...thread, messages, draft: false };
}

/**
 * What to call someone in a line: their first name when the mail gave a
 * name, or else the part of their address before the at sign.
 */
export function mailFirstName(person: MailPerson): string {
  // "Rossi, Marco" is a surname first: the given name is after the comma.
  const name = /^[^,]+,\s*\S/.test(person.name) ? person.name.split(',')[1]!.trim() : person.name;
  const first = name.split(/\s+/).find((part) => /\p{L}/u.test(part) && !/^(dr|mr|mrs|ms|prof|ing|dott|avv|sig)\.?$/i.test(part));
  return first ?? person.address.split('@')[0] ?? person.address;
}
