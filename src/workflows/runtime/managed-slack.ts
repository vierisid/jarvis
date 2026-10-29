/** Narrow contract for the hosted bot. Manual Slack accounts keep their existing behaviour. */
export const MANAGED_SLACK_ACTIONS = ['slack_find_channel', 'slack_get_channel_info', 'slack_post_message', 'send_channel_message'] as const;
export function managedSlackInput(input: unknown): Record<string, unknown> | null {
  const value = input as {auth?:{data?:{jarvis_managed?:unknown}}} | null;
  return value?.auth?.data?.jarvis_managed === 'slack' ? input as Record<string,unknown> : null;
}
export function managedSlackIssue(action: unknown, input: Record<string,unknown>, resolved = true): string | null {
  if (!(MANAGED_SLACK_ACTIONS as readonly unknown[]).includes(action)) return 'This hosted Slack connection supports Find Channel, Get Channel Info and bot messages only. Slack triggers are not enabled.';
  const dynamic = (v: unknown) => !resolved && typeof v === 'string' && v.includes('{{');
  if (action !== 'slack_find_channel' && !dynamic(input.channel) && (typeof input.channel !== 'string' || !/^[CG][A-Z0-9]+$/.test(input.channel))) return 'Choose a Slack channel ID. Direct messages are not supported by this connection.';
  if (action === 'slack_post_message' || action === 'send_channel_message') {
    if (input.sendAsUser || (action === 'send_channel_message' && input.sendAsBot === false)) return 'Hosted Slack messages must be sent as the Jarvis bot.';
    if (['file','username','profilePicture','iconEmoji','mentionOriginFlow'].some(k=>input[k])) return 'Files and custom message identities are not supported by this connection.';
    if (!dynamic(input.threadTs) && input.threadTs && (typeof input.threadTs !== 'string' || !/^\d+\.\d{6}$/.test(input.threadTs))) return 'Use the parent message timestamp (ts) to reply in a thread.';
    if (!dynamic(input.text) && input.text != null && typeof input.text !== 'string') return 'Slack message text must be a string.';
    if (!dynamic(input.blocks) && input.blocks != null && !Array.isArray(input.blocks)) return 'Slack blocks must be an array.';
    if (!input.text && !dynamic(input.blocks) && !(Array.isArray(input.blocks) && input.blocks.length)) return 'Enter message text or blocks.';
  }
  return null;
}

/** Section size the published 0.23.1 piece splits message text at. */
const SECTION_TEXT_LIMIT = 3000;
/** The published piece renders text as mrkdwn section blocks ahead of any
 * custom blocks. Slack treats top-level text only as a notification fallback
 * once blocks are present, so sending text and blocks as-is would hide the
 * reviewed text whenever both are set. */
export function messageBlocks(input: Record<string,unknown>): unknown[] | undefined {
  const blocks: unknown[] = [];
  let rest = typeof input.text === 'string' ? input.text : '';
  while (rest.length > 0) {
    if (rest.length <= SECTION_TEXT_LIMIT) { blocks.push({type:'section',text:{type:'mrkdwn',text:rest}}); break; }
    let cut = rest.lastIndexOf('\n', SECTION_TEXT_LIMIT);
    if (cut <= 0) cut = rest.lastIndexOf(' ', SECTION_TEXT_LIMIT);
    if (cut <= 0) cut = SECTION_TEXT_LIMIT;
    blocks.push({type:'section',text:{type:'mrkdwn',text:rest.substring(0,cut)}});
    rest = rest.substring(cut).trimStart();
  }
  if (Array.isArray(input.blocks)) blocks.push(...input.blocks);
  return blocks.length ? blocks : undefined;
}

/** One POST, no SDK retries. A lost response leaves the existing completion
 * receipt uncertain so the workflow cannot automatically send it again. */
export async function sendManagedSlackMessage(input: Record<string,unknown>, request: typeof fetch = fetch): Promise<unknown> {
  const auth=input.auth as {access_token:string};
  let response:Response;
  try { response=await request('https://slack.com/api/chat.postMessage', {
    method:'POST', headers:{Authorization:'Bearer '+auth.access_token,'Content-Type':'application/json'},
    redirect:'error', signal:AbortSignal.timeout(15000),
    body:JSON.stringify({channel:input.channel, text:input.text || undefined,
      blocks:messageBlocks(input), thread_ts:input.threadTs || undefined,
      reply_broadcast:input.replyBroadcast === true, unfurl_links:input.unfurlLinks !== false}),
  }); } catch { throw new Error('Slack send outcome is unknown. Check the channel before trying again.'); }
  if (!response.ok) throw new Error(response.status===429 ? 'Slack rate limited this send. Check the channel before trying again.' : 'Slack send did not finish. Check the channel before trying again.');
  // Never preserve upstream request headers or token-bearing SDK error objects.
  let body: {ok?:unknown;channel?:unknown;ts?:unknown;message?:unknown;error?:unknown};
  try {
    const reader=response.body?.getReader();
    if (!reader) throw new Error('Empty response');
    const chunks:Uint8Array[]=[];
    let size=0;
    try {
      for (;;) {
        const {done,value}=await reader.read();
        if (done) break;
        size+=value.length;
        if (size>1_048_576) throw new Error('Response too large');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const bytes=new Uint8Array(size);
    let offset=0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset+=chunk.length; }
    const parsed:unknown=JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('Invalid response');
    body=parsed;
  } catch {
    // Parse/stream errors may contain upstream response text. Keep the send
    // uncertain and never expose that text to the workflow's run history.
    throw new Error('Slack send outcome is unknown. Check the channel before trying again.');
  }
  if (body.ok!==true || body.channel!==input.channel || typeof body.ts!=='string' || !/^\d+\.\d{6}$/.test(body.ts)) {
    const reason = body.error==='not_in_channel' ? 'Invite the Jarvis app to this channel first.'
      : ['invalid_auth','token_revoked','token_expired','account_inactive','missing_scope'].includes(String(body.error)) ? 'Reconnect Slack from your Account page.'
      : 'Check the channel before trying again.';
    throw new Error('Slack did not confirm the message. '+reason);
  }
  return {ok:true,channel:body.channel,ts:body.ts,message:body.message};
}
