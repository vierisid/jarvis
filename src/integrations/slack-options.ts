import type {JarvisConfig} from '../config/types';
import {readSlackConnection} from './slack-connection';

export class SlackOptionsError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
type Channel = {id:string;name:string;is_member:boolean;is_archived:boolean};
function channelsPage(raw: unknown): {channels:Channel[];cursor:string} {
  const value=raw as {ok?:unknown;channels?:unknown;response_metadata?:{next_cursor?:unknown}} | null;
  const cursor=value?.response_metadata?.next_cursor ?? '';
  if (value?.ok !== true || !Array.isArray(value.channels) || value.channels.length>200
    || typeof cursor !== 'string' || !/^[A-Za-z0-9_=+/-]{0,1024}$/.test(cursor)
    || !value.channels.every(c=>c && typeof c.id==='string' && /^[CG][A-Z0-9]+$/.test(c.id)
      && typeof c.name==='string' && c.name.length<=512 && typeof c.is_member==='boolean' && typeof c.is_archived==='boolean')) {
    throw new SlackOptionsError('Could not load Slack channels. Try again.');
  }
  return {channels:value.channels as Channel[],cursor};
}

/** One bounded read-only page. Tokens and provider error bodies never reach the UI. */
export async function slackOptions(config: JarvisConfig, query: URLSearchParams, request: typeof fetch = fetch) {
  const connection = readSlackConnection(config.daemon.data_dir);
  if (!connection) throw new SlackOptionsError('Connect Slack before choosing a channel.', 409);
  const cursor = query.get('cursor') ?? '';
  if (!/^[A-Za-z0-9_=+/-]{0,1024}$/.test(cursor)) throw new SlackOptionsError('Invalid channel page. Reload channels.', 400);
  const params = new URLSearchParams({types:'public_channel,private_channel',exclude_archived:'true',limit:'200'});
  if (cursor) params.set('cursor',cursor);
  let response: Response;
  try { response = await request('https://slack.com/api/conversations.list?' + params, {
    headers:{Authorization:'Bearer '+connection.access_token}, redirect:'error', signal:AbortSignal.timeout(15000),
  }); } catch { throw new SlackOptionsError('Could not reach Slack. Try again.'); }
  if (response.status === 429) throw new SlackOptionsError('Slack is rate limiting requests. Wait a moment and try again.',429);
  if (response.status === 401 || response.status === 403) throw new SlackOptionsError('Slack refused access. Reconnect Slack.',409);
  if (!response.ok) throw new SlackOptionsError('Could not load Slack channels. Try again.');
  let raw: unknown;
  try {
    // Bound the stream, not just Content-Length (which may be absent).
    const reader=response.body?.getReader(); if(!reader) throw new Error('empty');
    const chunks:Uint8Array[]=[]; let size=0;
    try { for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw new Error('large');chunks.push(value);} }
    finally {await reader.cancel();reader.releaseLock();}
    raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new SlackOptionsError('Slack returned an invalid channel list. Try again.'); }
  const error = (raw as {error?:unknown})?.error;
  if (['invalid_auth','token_revoked','token_expired','account_inactive','missing_scope'].includes(String(error))) {
    throw new SlackOptionsError('Slack access has changed. Reconnect Slack from your Account page.',409);
  }
  if (error === 'ratelimited') throw new SlackOptionsError('Slack is rate limiting requests. Wait a moment and try again.',429);
  const parsed=channelsPage(raw);
  return {options:parsed.channels.filter(c=>c.is_member && !c.is_archived).map(c=>({value:c.id,label:'#'+c.name})),
    next_cursor:parsed.cursor, generation:connection.generation};
}
