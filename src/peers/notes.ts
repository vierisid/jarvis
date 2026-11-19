/**
 * A note: a few words of data that ride on a message between two Jarvises.
 *
 * The engine carries text. For the other notch to show keys in place of
 * prose (a question with its answers, "seen") the two Jarvises agree on a
 * last line of the text:
 *
 *   The review on Thursday or Friday?
 *   [[jarvis:1 {"kind":"ask","options":["Thursday","Friday","Neither"]}]]
 *
 * A contact who is not on Jarvis reads the sentence above it and one odd
 * line. The number is the version of this agreement.
 *
 * A note is written by the other side. It is read as data and checked field
 * by field; what does not check is no note, and the text is then a plain
 * message. Nothing in a note is ever followed.
 */

/** What the other notch is to know about the message it rides on. */
export type PeerNote =
  /** A question with its answers: one key each. */
  | { kind: 'ask'; options: string[] }
  /** The answer to a question (`replyTo` says which). */
  | { kind: 'answer'; pick: string }
  /** The person saw the message this replies to. */
  | { kind: 'seen' }
  /** The question this replies to is taken back. */
  | { kind: 'back' }
  /** The name of the organisation the two are now in. */
  | { kind: 'org'; name: string };

export const PEER_NOTE_VERSION = 1;
export const PEER_OPTIONS_MAX = 4;
export const PEER_OPTION_MAX = 40;
export const PEER_ORG_MAX = 60;

const LINE = /(?:^|\n)\[\[jarvis:(\d+) (\{[^\n]{0,2000}\})\]\][ \t]*$/;

/** Only what a person can read: no control characters, no line breaks, no runs of spaces. */
export function peerPlain(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202f\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function checked(raw: unknown): PeerNote | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const note = raw as Record<string, unknown>;
  if (note.kind === 'seen' || note.kind === 'back') return { kind: note.kind };
  if (note.kind === 'ask') {
    if (!Array.isArray(note.options) || note.options.length < 2 || note.options.length > PEER_OPTIONS_MAX) return null;
    const options = note.options.map((one) => (typeof one === 'string' ? peerPlain(one, PEER_OPTION_MAX) : ''));
    if (options.some((one) => !one) || new Set(options.map((one) => one.toLowerCase())).size !== options.length) return null;
    return { kind: 'ask', options };
  }
  if (note.kind === 'answer') {
    const pick = typeof note.pick === 'string' ? peerPlain(note.pick, PEER_OPTION_MAX) : '';
    return pick ? { kind: 'answer', pick } : null;
  }
  if (note.kind === 'org') {
    const name = typeof note.name === 'string' ? peerPlain(note.name, PEER_ORG_MAX) : '';
    return name ? { kind: 'org', name } : null;
  }
  return null;
}

/** The text of a message that carries a note. */
export function peerNoteText(words: string, note: PeerNote): string {
  return `${words}\n[[jarvis:${PEER_NOTE_VERSION} ${JSON.stringify(note)}]]`;
}

/** A message's words, and its note when it carries one that checks. */
export function peerNoteRead(text: string): { words: string; note: PeerNote | null } {
  const found = LINE.exec(text);
  if (!found || Number(found[1]) !== PEER_NOTE_VERSION) return { words: text, note: null };
  let raw: unknown;
  try { raw = JSON.parse(found[2]!); } catch { return { words: text, note: null }; }
  const note = checked(raw);
  return note ? { words: text.slice(0, found.index), note } : { words: text, note: null };
}
