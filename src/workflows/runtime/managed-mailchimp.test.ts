import {expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mailchimpSubscriberHash, managedMailchimpIssue, runManagedMailchimpAction} from './managed-mailchimp';
import {authorizePieceDispatch, executeAuthorizedPiece} from './piece-effect-guard';
import {compileWorkflow} from './workflow-readiness';
import {resolveGovernedPieceAction, tracksPieceCompletion} from './piece-effects';
const input = {auth: {access_token: 'SECRET', server_prefix: 'us1', jarvis_managed: 'mailchimp'}, list_id: 'audience1', email: 'USER@example.com', tag_name: 'Customer'};
const fake = (fn: (...args: any[]) => Promise<Response>) => fn as unknown as typeof fetch;

test('subscriber identifiers match MD5 across ASCII, Unicode and block boundaries', () => {
  for (const email of ['', 'USER@example.com', 'é@example.com', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(254)]) {
    expect(mailchimpSubscriberHash(email)).toBe(createHash('md5').update(email.toLowerCase()).digest('hex'));
  }
});
test('managed allowlist rejects sends, triggers, custom API, path injection and hidden filters', () => {
  for (const action of ['send_campaign','create_campaign','new_subscriber','custom_api_call','unsubscribe_email']) expect(managedMailchimpIssue(action, input)).not.toBeNull();
  for (const value of [{list_id: '../evil'}, {email: 'bad'}, {tag_name: ''}, {fields: 'access_token'}]) expect(managedMailchimpIssue('add_subscriber_to_tag', {...input, ...value})).not.toBeNull();
  expect(managedMailchimpIssue('find_subscriber', {...input, list_id: '{{find.id}}'}, false)).toBeNull();
});
test('tag changes use one request, fixed host, header token and suppressed automations', async () => {
  for (const action of ['add_subscriber_to_tag','remove_subscriber_from_tag']) {
    let calls = 0;
    const result = await runManagedMailchimpAction(action, input, fake(async (url, init) => {
      calls++; expect(url).toBe('https://us1.api.mailchimp.com/3.0/lists/audience1/members/b58996c504c5638798eb6b511e6f49af/tags');
      expect(init.redirect).toBe('error'); expect(init.method).toBe('POST'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer SECRET');
      expect(JSON.parse(init.body)).toEqual({tags: [{name: 'Customer', status: action === 'add_subscriber_to_tag' ? 'active' : 'inactive'}], is_syncing: true});
      return new Response(null, {status: 204});
    }));
    expect(result).toMatchObject({success: true, data: {automations_suppressed: true}}); expect(calls).toBe(1);
  }
});
test('provider/network failures do not retry or disclose response bodies', async () => {
  for (const failure of ['network','429','401','403','404','500','json','large','stream']) {
    let calls = 0;
    const request = fake(async () => {calls++; if (failure === 'network') throw Error('PRIVATE');
      if (failure === 'large') return new Response('x'.repeat(1048577));
      if (failure === 'stream') return new Response(new ReadableStream({start(c) {c.error(Error('PRIVATE'));}}));
      return new Response('PRIVATE', {status: Number(failure) || 200});});
    try {await runManagedMailchimpAction('add_subscriber_to_tag', input, request); throw Error('expected failure');}
    catch (e) {expect(String(e)).toContain('Mailchimp'); expect(String(e)).not.toContain('PRIVATE');}
    expect(calls).toBe(1);
  }
});
test('invalid data-center prefix cannot cause an outbound request', async () => {
  await expect(runManagedMailchimpAction('find_subscriber', {...input, auth: {...input.auth, server_prefix: 'us1.evil.test'}}, fake(async () => {throw Error('must not call');}))).rejects.toThrow('Reconnect');
});
test('subscriber output is exact, bounded in shape and distinguishes a missing audience', async () => {
  const raw = {id: mailchimpSubscriberHash(input.email), email_address: 'user@example.com', list_id: 'audience1', status: 'subscribed', private: 'SECRET'};
  const result = await runManagedMailchimpAction('find_subscriber', input, fake(async () => Response.json(raw)));
  expect(result).toMatchObject({found: true, primary_subscriber: {email_address: 'user@example.com'}}); expect(JSON.stringify(result)).not.toContain('SECRET');
  await expect(runManagedMailchimpAction('find_subscriber', input, fake(async () => Response.json({...raw, list_id: 'other'})))).rejects.toThrow('different subscriber');
  let calls = 0;
  expect(await runManagedMailchimpAction('find_subscriber', input, fake(async () => ++calls === 1 ? new Response('', {status: 404}) : Response.json({id: 'audience1'})))).toMatchObject({found: false, primary_subscriber: null});
  await expect(runManagedMailchimpAction('find_subscriber', input, fake(async () => new Response('', {status: 404})))).rejects.toThrow('could not find');
});
test('campaign results expose pagination and report projections drop transport fields', async () => {
  const search = await runManagedMailchimpAction('find_campaign', {...input, query: 'Monthly & news'}, fake(async url => {
    expect(url).toContain('query=Monthly%20%26%20news'); return Response.json({total_items: 2, results: [{campaign: {id: 'campaign1', status: 'sent', settings: {title: 'Newsletter', private: 'SECRET'}, private: 'SECRET'}}]});
  }));
  expect(search).toMatchObject({has_more: true, results: [{campaign: {id: 'campaign1'}}]}); expect(JSON.stringify(search)).not.toContain('SECRET');
  const report = await runManagedMailchimpAction('get_campaign_report', {...input, campaign_id: 'campaign1'}, fake(async () => Response.json({id: 'campaign1', campaign_title: 'Newsletter', emails_sent: 0, opens: {unique_opens: 0, open_rate: 0}, clicks: {unique_clicks: 0, click_rate: 0}, bounces: {}, _links: [{href: 'SECRET'}]})));
  expect(report).toMatchObject({summary: {emails_sent: 0, open_rate: 0}}); expect(JSON.stringify(report)).not.toContain('SECRET');
});
const params = {apiUrl: 'http://unused', engineToken: 'test', piece: '@activepieces/piece-mailchimp', action: 'add_subscriber_to_tag', stepName: 'step', executionPath: [], input};
test('managed actions cannot bypass authority; completed receipts prevent duplicate sends', async () => {
  await expect(authorizePieceDispatch({...params, action: 'send_campaign', fetchImpl: fake(async () => {throw Error('must not call');})})).rejects.toThrow('not enabled');
  await expect(executeAuthorizedPiece({...params, action: 'find_subscriber'}, {governed: false}, async () => {})).rejects.toThrow('not authorized');
  expect(await executeAuthorizedPiece(params, {governed: true, dispatch: 'completed', result: {success: true}}, async () => {throw Error('must not run');})).toEqual({success: true});
  await expect(executeAuthorizedPiece({...params, input: {...input, list_id: '../edited'}}, {governed: true, dispatch: 'authorized', effectId: 'effect'}, async () => {})).rejects.toThrow('valid Mailchimp');
});
test('authority digest binds token and server without revealing either secret', async () => {
  let sent: any;
  const fetchImpl = fake(async (_url, init) => {sent = JSON.parse(init.body); return Response.json({governed: true, dispatch: 'authorized', effectId: 'effect'});});
  await authorizePieceDispatch({...params, fetchImpl}); const first = sent.credentialDigest;
  expect(first).toMatch(/^[a-f0-9]{64}$/); expect(JSON.stringify(sent)).not.toContain('SECRET');
  await authorizePieceDispatch({...params, input: {...input, auth: {...input.auth, server_prefix: 'us2'}}, fetchImpl}); expect(sent.credentialDigest).not.toBe(first);
});
test('readiness rejects unsupported managed triggers, however the binding is spelled', () => {
  for (const auth of ['{{connections.jarvis:mailchimp}}', "{{connections['jarvis:mailchimp']}}", ' {{connections.jarvis:mailchimp}}']) {
    expect(JSON.stringify(compileWorkflow({name: 'trigger', type: 'PIECE', settings: {pieceName: params.piece, triggerName: 'subscribe', input: {auth}}}))).toContain('MANAGED_MAILCHIMP');
  }
});
// Every action of the pinned 0.5.10 bundle (no custom_api_call); the gated engine test checks the installed package.
const MAILCHIMP_0510_ACTIONS: Record<string, string> = {
  find_subscriber: 'read_data', find_campaign: 'read_data', get_campaign_report: 'read_data', find_customer: 'read_data', find_tag: 'read_data',
  send_campaign: 'send_email', archive_subscriber: 'delete_data',
  add_subscriber_to_tag: 'write_data', remove_subscriber_from_tag: 'write_data', add_member_to_list: 'write_data', add_note_to_subscriber: 'write_data',
  update_member_in_list: 'write_data', unsubscribe_email: 'write_data', create_campaign: 'write_data', create_audience: 'write_data',
  create_tag: 'write_data', create_custom_event: 'write_data',
};
test('every 0.5.10 action is governed by category: a campaign send is an email send, archiving a delete', () => {
  for (const [action, category] of Object.entries(MAILCHIMP_0510_ACTIONS)) {
    expect({action, ...resolveGovernedPieceAction(params.piece, action)}).toMatchObject({action, category, known: true});
    // Changes are tracked so an uncertain send or write is not repeated; reads never are.
    expect(tracksPieceCompletion(params.piece, action)).toBe(category !== 'read_data');
  }
  for (const action of ['custom_api_call', 'added_upstream']) expect(resolveGovernedPieceAction(params.piece, action)).toMatchObject({category: 'modify_settings', known: false});
});
