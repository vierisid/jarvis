/** Pure, bounded document protocol shared by the daemon and engine bundle.
 * Unknown props/actions and rich/opaque payloads stay on the read-only path.
 * This is not a tool-argument editor. Auth never crosses this protocol.
 */
export type DecisionDocument =
  | { kind: 'email'; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }
  | { kind: 'calendar'; title: string; description: string; start: string; end: string; attendees: string[]; location: string };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, max: number, required = false): string {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || /[\u0000-\u0008\u000b-\u001f\u007f]|<<<(?:END_)?UNTRUSTED_CONTENT/u.test(v)) throw Error('Invalid document text');
  return v;
}
function addresses(v: unknown, required = false): string[] {
  if (!Array.isArray(v) || v.length > 25 || (required && !v.length) || v.some(s => typeof s !== 'string' || s.length > 254 || !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/u.test(s))) throw Error('Invalid document addresses');
  return [...v];
}
function date(v: unknown): string {
  const s = text(v, 40, true);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(s) || !Number.isFinite(Date.parse(s))) throw Error('Use an ISO date with an explicit timezone');
  const [year, month, day, hour, minute, second] = s.slice(0, 19).split(/[-T:]/u).map(Number);
  if (month! < 1 || month! > 12 || day! < 1 || day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() || hour! > 23 || minute! > 59 || second! > 59) throw Error('Invalid calendar date');
  return s;
}
export function validateDecisionDocument(v: unknown): DecisionDocument {
  if (!object(v)) throw Error('Invalid document');
  const keys = v.kind === 'email' ? ['kind','to','cc','bcc','subject','body'] : ['kind','title','description','start','end','attendees','location'];
  if (Object.keys(v).some(k => !keys.includes(k))) throw Error('Unknown document field');
  if (v.kind === 'email') return { kind: 'email', to: addresses(v.to, true), cc: addresses(v.cc), bcc: addresses(v.bcc), subject: text(v.subject, 512, true), body: text(v.body, 16_000, true) };
  if (v.kind !== 'calendar') throw Error('Unsupported document');
  const start = date(v.start), end = date(v.end);
  if (Date.parse(end) <= Date.parse(start)) throw Error('Event end must follow its start');
  return { kind: 'calendar', title: text(v.title, 512, true), description: text(v.description, 16_000), start, end, attendees: addresses(v.attendees), location: text(v.location, 512) };
}
/** Returns the complete supported input without credentials, never a truncated executable payload. */
export function documentInput(piece: unknown, action: unknown, raw: unknown): Record<string, unknown> | null {
  if (!object(raw)) return null;
  const email = piece === '@activepieces/piece-gmail' && ['send_email','gmail_send_email'].includes(String(action));
  const calendar = piece === '@activepieces/piece-google-calendar' && ['create_google_calendar_event','google_calendar_create_event'].includes(String(action));
  if (!email && !calendar) return null;
  const allowed = email
    ? ['receiver','cc','bcc','subject','body','body_type','draft','attachments','from','sender_name','reply_to','in_reply_to']
    : ['calendar_id','title','description','start_date_time','end_date_time','attendees','location','colorId','create_meet_link','guests_can_invite_others','guests_can_modify','guests_can_see_other_guests','send_notifications'];
  try {
    const input: Record<string, unknown> = {};
    for (const [k,v] of Object.entries(raw)) {
      if (k === 'auth') continue;
      if (!allowed.includes(k)) return null;
      if (v !== undefined) input[k] = v;
    }
    if (email) {
      // Replies, attachments, HTML and provider-side draft mutations need their own adapters.
      if (input.body_type !== 'plain_text' || (input.draft !== undefined && input.draft !== false)) return null;
      for (const k of ['attachments','reply_to']) if (input[k] !== undefined && (!Array.isArray(input[k]) || (input[k] as unknown[]).length)) return null;
      for (const k of ['from','sender_name','in_reply_to']) if (input[k] !== undefined && input[k] !== '') return null;
    } else {
      text(input.calendar_id, 512, true);
      for (const k of ['create_meet_link','guests_can_invite_others','guests_can_modify','guests_can_see_other_guests']) if (input[k] !== undefined && typeof input[k] !== 'boolean') return null;
      if (input.colorId !== undefined) text(input.colorId, 16);
      if (!['all','externalOnly','none'].includes(String(input.send_notifications))) return null;
    }
    projectDocument(piece, action, input);
    return JSON.parse(JSON.stringify(input));
  } catch { return null; }
}
export function projectDocument(piece: unknown, action: unknown, input: Record<string, unknown>): DecisionDocument {
  if (piece === '@activepieces/piece-gmail' && ['send_email','gmail_send_email'].includes(String(action))) return validateDecisionDocument({ kind: 'email', to: input.receiver, cc: input.cc ?? [], bcc: input.bcc ?? [], subject: input.subject, body: input.body });
  if (piece === '@activepieces/piece-google-calendar' && ['create_google_calendar_event','google_calendar_create_event'].includes(String(action))) return validateDecisionDocument({ kind: 'calendar', title: input.title, description: input.description ?? '', start: input.start_date_time, end: input.end_date_time, attendees: input.attendees ?? [], location: input.location ?? '' });
  throw Error('Unsupported document action');
}
export function applyDocument(piece: unknown, action: unknown, raw: unknown, value: unknown): Record<string, unknown> {
  const input = documentInput(piece, action, raw), doc = validateDecisionDocument(value);
  if (!input || projectDocument(piece, action, input).kind !== doc.kind) throw Error('Document adapter does not match this action');
  return { ...input, ...documentFields(doc) };
}
/** Only editable fields, suitable for overlaying an already-censored run input. */
export function documentFields(value: unknown): Record<string, unknown> {
  const doc = validateDecisionDocument(value);
  return doc.kind === 'email' ? { receiver: doc.to, cc: doc.cc, bcc: doc.bcc, subject: doc.subject, body: doc.body }
    : { title: doc.title, description: doc.description, start_date_time: doc.start, end_date_time: doc.end, attendees: doc.attendees, location: doc.location };
}
