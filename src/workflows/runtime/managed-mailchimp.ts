/**
 * Fetch-only managed adapter. No SDK retries, arbitrary paths or provider error bodies.
 * Only these actions are qualified for the managed connection; sending
 * campaigns, (un)subscribing, audience changes, custom API calls and triggers
 * are refused. Manual connections keep the wider community piece behaviour.
 */
export const MANAGED_MAILCHIMP_ACTIONS = ['find_subscriber', 'add_subscriber_to_tag', 'remove_subscriber_from_tag', 'find_campaign', 'get_campaign_report'] as const;
export function managedMailchimpInput(input: unknown): Record<string, unknown> | null {
  return (input as {auth?: {jarvis_managed?: unknown}} | null)?.auth?.jarvis_managed === 'mailchimp' ? input as Record<string, unknown> : null;
}
export function managedMailchimpIssue(action: unknown, input: Record<string, unknown>, resolved = true): string | null {
  if (!(MANAGED_MAILCHIMP_ACTIONS as readonly unknown[]).includes(action)) return 'This Mailchimp connection supports subscriber lookup, adding and removing tags, campaign search and reports. Sending campaigns and triggers are not enabled.';
  const dynamic = (v: unknown) => !resolved && typeof v === 'string' && v.includes('{{');
  const subscriber = ['find_subscriber', 'add_subscriber_to_tag', 'remove_subscriber_from_tag'].includes(String(action));
  for (const key of subscriber ? ['list_id'] : action === 'get_campaign_report' ? ['campaign_id'] : []) {
    if (!dynamic(input[key]) && (typeof input[key] !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(input[key] as string))) return 'Choose a valid Mailchimp audience or campaign, or a workflow variable.';
  }
  if (subscriber && !dynamic(input.email) && (typeof input.email !== 'string' || input.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))) return 'Enter a valid subscriber email address.';
  for (const key of action === 'find_campaign' ? ['query'] : subscriber && action !== 'find_subscriber' ? ['tag_name'] : []) {
    if (!dynamic(input[key]) && (typeof input[key] !== 'string' || !(input[key] as string).trim() || (input[key] as string).length > 100)) return `Enter ${key === 'query' ? 'a campaign search' : 'a tag name'} of 1 to 100 characters.`;
  }
  for (const key of ['fields', 'include_fields', 'exclude_fields']) {
    if (input[key] != null && input[key] !== '' && (!Array.isArray(input[key]) || (input[key] as unknown[]).length)) return 'Remove custom field filters. The hosted Mailchimp connection returns a fixed set of subscriber and report fields.';
  }
  return null;
}
export interface MailchimpAuth {access_token: string; server_prefix: string}
export class MailchimpRequestError extends Error {
  constructor(message: string, readonly status: number) {super(message);}
}
export async function mailchimpJson(path: string, auth: MailchimpAuth, init: RequestInit = {}, request: typeof fetch = fetch): Promise<unknown> {
  if (!auth || typeof auth.access_token !== 'string' || !auth.access_token || auth.access_token.length > 16384 || !/^us[1-9][0-9]{0,3}$/.test(auth.server_prefix)) throw new MailchimpRequestError('Reconnect Mailchimp.', 401);
  // Callers supply only fixed endpoint templates and encoded, validated inputs.
  if (!/^(?:lists|reports|search-campaigns|campaigns)(?:[/?]|$)/.test(path) || path.includes('..') || path.includes('#') || path.includes('\\')) throw new MailchimpRequestError('Invalid Mailchimp endpoint.', 400);
  let response: Response;
  try {
    response = await request(`https://${auth.server_prefix}.api.mailchimp.com/3.0/${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + auth.access_token},
    });
  } catch {throw new MailchimpRequestError('Mailchimp did not confirm the request. Check the audience before trying again.', 502);}
  if (response.status === 401 || response.status === 403) throw new MailchimpRequestError('Mailchimp refused access. Check account permissions or reconnect Mailchimp.', response.status);
  if (response.status === 429) throw new MailchimpRequestError('Mailchimp is rate limiting requests. Wait before trying again.', 429);
  if (response.status === 404) throw new MailchimpRequestError('Mailchimp could not find this audience, subscriber or sent campaign. Check the selection.', 404);
  if (!response.ok) throw new MailchimpRequestError('Mailchimp did not confirm the request. Check the audience before trying again.', response.status);
  if (response.status === 204) return null;
  try {
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty');
    const chunks: Uint8Array[] = []; let size = 0;
    try {for (;;) {const {done, value} = await reader.read(); if (done) break; size += value.length; if (size > 1048576) throw new Error('large'); chunks.push(value);}}
    finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) {bytes.set(chunk, offset); offset += chunk.length;}
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {throw new MailchimpRequestError('Mailchimp returned an invalid response. Check the audience before trying again.', 502);}
}

/** RFC 1321 identifier only, not cryptography. Mailchimp requires MD5(lowercase email).
 * Pure JS keeps the engine bundle free of Node and SDK dependencies. */
export function mailchimpSubscriberHash(email: string): string {
  const bytes = new TextEncoder().encode(email.toLowerCase());
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64); padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer); view.setUint32(padded.length - 8, bytes.length * 8, true);
  const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      const round = Math.floor(i / 16);
      const f = round === 0 ? (b & c) | (~b & d) : round === 1 ? (d & b) | (~d & c) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
      const g = round === 0 ? i : round === 1 ? (5*i+1)%16 : round === 2 ? (3*i+5)%16 : (7*i)%16;
      const x = (a + f + Math.floor(Math.abs(Math.sin(i+1))*4294967296) + view.getUint32(offset+g*4, true)) | 0;
      const shift = shifts[round*4+i%4]!;
      a = d; d = c; c = b; b = (b + ((x << shift) | (x >>> (32-shift)))) | 0;
    }
    a0 = (a0+a)|0; b0 = (b0+b)|0; c0 = (c0+c)|0; d0 = (d0+d)|0;
  }
  const out = new DataView(new ArrayBuffer(16)); [a0,b0,c0,d0].forEach((v,i) => out.setUint32(i*4,v,true));
  return Array.from(new Uint8Array(out.buffer), b => b.toString(16).padStart(2,'0')).join('');
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MailchimpRequestError('Mailchimp returned an invalid object.', 502);
  return value as Record<string, unknown>;
}
function project(value: unknown, keys: string[]): Record<string, unknown> {
  const raw = object(value), out: Record<string, unknown> = {};
  for (const key of keys) {const v = raw[key]; if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'string') out[key] = v;}
  return out;
}
function identified(value: unknown): Record<string, unknown> {
  const raw = object(value);
  if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9]{1,64}$/.test(raw.id)) throw new MailchimpRequestError('Mailchimp returned an invalid identifier.', 502);
  return raw;
}
export async function runManagedMailchimpAction(action: string, input: Record<string, unknown>, request: typeof fetch = fetch): Promise<unknown> {
  const issue = managedMailchimpIssue(action, input); if (issue) throw new Error(issue);
  const auth = input.auth as MailchimpAuth;
  if (action === 'find_subscriber' || action === 'add_subscriber_to_tag' || action === 'remove_subscriber_from_tag') {
    const email = (input.email as string).toLowerCase(), hash = mailchimpSubscriberHash(email);
    const path = `lists/${input.list_id}/members/${hash}`;
    if (action !== 'find_subscriber') {
      const status = action === 'add_subscriber_to_tag' ? 'active' : 'inactive';
      // is_syncing stops the tag change from firing tag-triggered Mailchimp automations.
      const response = await mailchimpJson(path + '/tags', auth, {method: 'POST', body: JSON.stringify({tags: [{name: input.tag_name, status}], is_syncing: true})}, request);
      if (response !== null) throw new MailchimpRequestError('Mailchimp did not confirm the tag change. Check the audience before trying again.', 502);
      return {success: true, data: {list_id: input.list_id, email_address: email, tag_name: input.tag_name, status, automations_suppressed: true}};
    }
    let raw: Record<string, unknown>;
    try {raw = identified(await mailchimpJson(path, auth, {}, request));}
    catch (error) {
      if (!(error instanceof MailchimpRequestError) || error.status !== 404) throw error;
      // A missing audience must not masquerade as a missing subscriber.
      const audience = identified(await mailchimpJson(`lists/${input.list_id}?fields=id`, auth, {}, request));
      if (audience.id !== input.list_id) throw new MailchimpRequestError('Mailchimp did not confirm the audience.', 502);
      return {success: true, found: false, total_matches: 0, subscribers: [], primary_subscriber: null};
    }
    if (raw.id !== hash || raw.list_id !== input.list_id || typeof raw.email_address !== 'string' || raw.email_address.toLowerCase() !== email || typeof raw.status !== 'string') throw new MailchimpRequestError('Mailchimp returned a different subscriber. Check the audience.', 502);
    const subscriber = project(raw, ['id','list_id','email_address','status','email_type','language','vip','last_changed','tags_count']);
    return {success: true, found: true, total_matches: 1, subscribers: [subscriber], primary_subscriber: subscriber};
  }
  if (action === 'find_campaign') {
    const raw = object(await mailchimpJson('search-campaigns?query=' + encodeURIComponent(input.query as string), auth, {}, request));
    if (!Array.isArray(raw.results) || raw.results.length > 1000 || typeof raw.total_items !== 'number' || !Number.isInteger(raw.total_items) || raw.total_items < raw.results.length) throw new MailchimpRequestError('Mailchimp returned invalid campaign results.', 502);
    const results = raw.results.map(value => {
      const item = object(value), campaign = identified(item.campaign);
      return {campaign: {...project(campaign, ['id','type','status','emails_sent','send_time']), settings: project(campaign.settings, ['title','subject_line'])}};
    });
    return {success: true, query: input.query, results, total_items: raw.total_items, has_more: raw.total_items > results.length};
  }
  const raw = identified(await mailchimpJson(`reports/${input.campaign_id}`, auth, {}, request));
  if (raw.id !== input.campaign_id || typeof raw.emails_sent !== 'number' || !Number.isFinite(raw.emails_sent) || raw.emails_sent < 0) throw new MailchimpRequestError('Mailchimp did not confirm the campaign report.', 502);
  const report = project(raw, ['id','campaign_title','type','list_id','list_name','subject_line','emails_sent','abuse_reports','unsubscribed','send_time']);
  const opens = project(raw.opens, ['opens_total','unique_opens','open_rate','last_open']);
  const clicks = project(raw.clicks, ['clicks_total','unique_clicks','unique_subscriber_clicks','click_rate','last_click']);
  const bounces = project(raw.bounces, ['hard_bounces','soft_bounces','syntax_errors']);
  return {success: true, report: {...report, opens, clicks, bounces}, summary: {
    campaign_title: report.campaign_title, subject_line: report.subject_line, emails_sent: report.emails_sent,
    unique_opens: opens.unique_opens, unique_clicks: clicks.unique_clicks, open_rate: opens.open_rate, click_rate: clicks.click_rate,
  }};
}
