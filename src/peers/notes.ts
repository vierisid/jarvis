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
  /**
   * A question is taken back. `of` is the id it was sent under: a message
   * can only be sent as a reply to something that arrived, and a taking back
   * is about something that was sent.
   */
  | { kind: 'back'; of: string }
  /** The name of the organisation the two are now in. */
  | { kind: 'org'; name: string }
  /**
   * A file is offered: what it is called, how large it is, in how many
   * pieces it would come, and what its bytes add up to (SHA-256). Nothing of
   * the file itself: that follows only after a yes.
   */
  | { kind: 'file'; id: string; name: string; size: number; parts: number; sha: string; want?: string }
  /**
   * A file is asked for, in words ("the Q3 numbers"). The other Pillow looks
   * for it and asks its owner, there, whether it may go. An offer that
   * answers it carries its id as `want`, and is then not asked about again:
   * the asking was the yes.
   */
  | { kind: 'file-want'; id: string; what: string }
  /** The owner there said no to what was asked for (`of` is the asking's id). */
  | { kind: 'file-want-no'; of: string }
  /** What became of an offer (`of` is its id): taken, turned down, arrived whole, or not whole. */
  | { kind: 'file-yes' | 'file-no' | 'file-got' | 'file-lost'; of: string }
  /** One piece of a file that was taken, the `n`th from nought. The message's words are the piece, in base64. */
  | { kind: 'file-part'; of: string; n: number };

export const PEER_NOTE_VERSION = 1;
export const PEER_OPTIONS_MAX = 4;
export const PEER_OPTION_MAX = 40;
export const PEER_ORG_MAX = 60;
/** The largest file that crosses, for now, and the size of one piece of it: what fits one message in base64. */
export const PEER_FILE_MAX = 25 * 1024 * 1024;
export const PEER_FILE_PART = 144 * 1024;
export const PEER_FILE_NAME_MAX = 120;
/** The longest description of a file that is asked for. */
export const PEER_FILE_WHAT_MAX = 120;

/** In how many pieces a file of this size comes. */
export const peerFileParts = (size: number): number => Math.ceil(size / PEER_FILE_PART);

/**
 * A file's name as it is shown and saved: the last part of a path, what a
 * person can read, and nothing that means something to a file system. The
 * name came from the other side, or from a file of unknown origin.
 */
export function peerFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const name = peerPlain(base, 400).replace(/[<>:"|?*]/g, '').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').slice(0, PEER_FILE_NAME_MAX).trim();
  return name || 'file';
}

const LINE = /(?:^|\n)\[\[jarvis:(\d+) (\{[^\n]{0,2000}\})\]\][ \t]*$/;

/**
 * Only what a person can read: no control characters, no line breaks, no runs
 * of spaces, and nothing that is there without being drawn. The last matters
 * most: text that cannot be seen on the notch can still be read by a model
 * and can still be sent. So every format character goes (the marks that hide,
 * join or reorder text, the soft hyphen), the tag characters that spell words
 * invisibly, the variation selectors, and the letters that draw nothing.
 */
/** Characters that break a line or stand for a gap: each becomes a blank. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Characters that are there without being drawn: each is taken out, so that the letters round it stay one word. */
const UNSEEN = /[\u115f\u1160\u3164\uffa0\ufe00-\ufe0f]|\p{Cf}|[\u{e0000}-\u{e0fff}]/gu;

export function peerPlain(text: string, max: number): string {
  return text.replace(UNSEEN, '').replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function checked(raw: unknown): PeerNote | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const note = raw as Record<string, unknown>;
  if (note.kind === 'seen') return { kind: 'seen' };
  if (note.kind === 'back') return typeof note.of === 'string' && /^[0-9a-f-]{36}$/i.test(note.of) ? { kind: 'back', of: note.of.toLowerCase() } : null;
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
  const id = (value: unknown): string | null => (typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value.toLowerCase() : null);
  if (note.kind === 'file') {
    const of = id(note.id);
    const size = note.size;
    if (!of || typeof note.name !== 'string' || typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > PEER_FILE_MAX) return null;
    // The pieces follow from the size. An offer that says otherwise is not one.
    if (note.parts !== peerFileParts(size) || typeof note.sha !== 'string' || !/^[0-9a-f]{64}$/.test(note.sha)) return null;
    const want = note.want === undefined ? null : id(note.want);
    // An offer that says it answers an asking, and names none that can be one, is not an offer.
    if (note.want !== undefined && !want) return null;
    return { kind: 'file', id: of, name: peerFileName(note.name), size, parts: note.parts, sha: note.sha, ...(want ? { want } : {}) };
  }
  if (note.kind === 'file-want') {
    const of = id(note.id);
    const what = typeof note.what === 'string' ? peerPlain(note.what, PEER_FILE_WHAT_MAX) : '';
    return of && what ? { kind: 'file-want', id: of, what } : null;
  }
  if (note.kind === 'file-want-no') {
    const of = id(note.of);
    return of ? { kind: 'file-want-no', of } : null;
  }
  if (note.kind === 'file-yes' || note.kind === 'file-no' || note.kind === 'file-got' || note.kind === 'file-lost') {
    const of = id(note.of);
    return of ? { kind: note.kind, of } : null;
  }
  if (note.kind === 'file-part') {
    const of = id(note.of);
    const n = note.n;
    return of && typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < peerFileParts(PEER_FILE_MAX) ? { kind: 'file-part', of, n } : null;
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
