import { ONBOARDING_ACTION, ONBOARDING_PIECE, ONBOARDING_REQUIRED, onboardCustomer, onboardingCustomer, onboardingSetup, onboardingTransport, type ResourceBranch, type ResourceState, type OnboardingStore } from './customer-onboarding';
import { digest } from './effect-context';
import { evaluateWorkflowExpression } from './safe-expression';

export const onboardingFixtureSetup = { customerIdPath: 'customer.id', customerNamePath: 'customer.name', clickupConnection: 'fixture-clickup', driveConnection: 'fixture-drive', clickupListId: '12345', driveParentId: 'fixture-parent' };
export const onboardingFixturePayload = { customer: { id: 'customer-1', name: 'Example Customer' } };
export function onboardingFixtureProvider() {
  const modes: Record<ResourceBranch, 'ok' | 'fail' | 'unknown' | 'malformed'> = { clickup: 'ok', drive: 'ok' };
  const calls: ResourceBranch[] = [], resources: ResourceBranch[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const u = new URL(String(url));
    const branch = u.origin === 'https://api.clickup.com' ? 'clickup' : u.origin === 'https://www.googleapis.com' ? 'drive' : null;
    if (!branch || init.method !== 'POST' || init.redirect !== 'error') throw Error('Fixture refused unexpected provider request');
    if (branch === 'clickup' && !/^\/api\/v2\/list\/\d+\/task$/.test(u.pathname) || branch === 'drive' && u.pathname !== '/drive/v3/files') throw Error('Unexpected create endpoint');
    calls.push(branch);
    if (modes[branch] === 'fail') return Response.json({ error: 'Synthetic rejection' }, { status: 403 });
    resources.push(branch);
    if (modes[branch] === 'unknown') throw Error('Synthetic lost response after creation');
    if (modes[branch] === 'malformed') return Response.json({});
    const body = JSON.parse(init.body);
    return Response.json(branch === 'clickup' ? { id: 'fixture-task' } : { id: 'fixture-folder', mimeType: body.mimeType, parents: body.parents });
  }) as typeof fetch;
  return { modes, calls, resources, fetchImpl };
}
export function memoryOnboardingStore(initial: Partial<Record<ResourceBranch, ResourceState>> = {}): OnboardingStore {
  const results = structuredClone(initial);
  return { check() {}, read: b => results[b], save(b, r) { results[b] = structuredClone(r); } };
}

/** Deliberately refuses additional nodes/expressions instead of claiming unrelated coverage. */
export async function validateOnboardingFixtures(trigger: any) {
  const action = trigger?.nextAction, notify = action?.nextAction;
  if (trigger?.type !== 'PIECE_TRIGGER' || trigger.settings?.pieceName !== 'webhook' || Object.values(trigger.settings.input ?? {}).some(v => v !== '' && v !== null && v !== undefined)
    || action?.type !== 'PIECE' || action.settings?.pieceName !== ONBOARDING_PIECE || action.settings?.actionName !== ONBOARDING_ACTION || action.settings.input?.customer !== '{{trigger}}'
    || notify?.type !== 'PIECE' || notify.settings?.pieceName !== '@jarvispieces/piece-jarvis-notify' || notify.settings?.actionName !== 'notify' || notify.nextAction
    || [trigger, action, notify].some(n => n.firstLoopAction || n.children || n.onErrorAction || n.settings.errorHandlingOptions?.continueOnFailure?.value === true || n.settings.errorHandlingOptions?.retryOnFailure?.value === true)
    || notify.settings.input?.message !== `{{${action.name}.summary}}` || notify.settings.input?.idempotencyKey !== `{{${action.name}.notificationKey}}`
    || JSON.stringify(notify.settings.input?.channels) !== '["dashboard"]') throw Error('Onboarding fixtures require exactly webhook -> create_resources(customer={{trigger}}) -> dashboard summary/key. Additional graph behavior is not covered.');
  const input = structuredClone(action.settings.input);
  for (const key of ONBOARDING_REQUIRED) if (input[key] === '' || input[key] === null || input[key] === undefined) input[key] = onboardingFixtureSetup[key];
  // Stored account names are not resolved; all providers below are strictly synthetic.
  const setup = onboardingSetup(input);
  const payload: Record<string, unknown> = {};
  for (const [path, value] of [[setup.customerIdPath, 'customer-1'], [setup.customerNamePath, 'Example Customer']]) {
    let node = payload as any; const parts = path!.split('.');
    for (const part of parts.slice(0,-1)) node = node[part] ??= {};
    node[parts.at(-1)!] = value;
  }
  const customer = onboardingCustomer(setup,payload);
  const cases: Array<{ name: string; passed: boolean }> = [];
  const assert = (ok: unknown, message: string) => { if (!ok) throw Error('Onboarding fixture failed: '+message); };
  for (const [name, clickup, drive] of [['both succeed','ok','ok'],['ClickUp fails','fail','ok'],['Drive fails','ok','fail'],['both fail','fail','fail'],['uncertain ClickUp','unknown','ok'],['uncertain Drive','ok','unknown'],['invalid provider receipt','ok','malformed']] as const) {
    const f = onboardingFixtureProvider(), store = memoryOnboardingStore();
    f.modes.clickup = clickup; f.modes.drive = drive;
    const create = onboardingTransport(setup,customer,async ()=>'synthetic',()=>{},f.fetchImpl);
    const first = await onboardCustomer(store,create,'fixture');
    assert(f.calls.length === 2,'both branches attempted');
    for (const b of ['clickup','drive'] as const) assert(first.outcomes[b].status === (f.modes[b] === 'ok' ? 'succeeded' : f.modes[b] === 'fail' ? 'failed' : 'unknown'),name+' '+b);
    const summaries = new Map<string,string>();
    const notifyResult = (result: unknown) => {
      const scope = { [action.name]: result };
      const text = evaluateWorkflowExpression(notify.settings.input.message.slice(2,-2),scope);
      const key = evaluateWorkflowExpression(notify.settings.input.idempotencyKey.slice(2,-2),scope);
      assert(typeof text === 'string' && text.includes('ClickUp task:') && text.includes('Drive folder:'),'combined summary');
      summaries.set(String(key),String(text));
    };
    notifyResult(first);
    f.modes.clickup='ok'; f.modes.drive='ok';
    const second = await onboardCustomer(store,create,'fixture'); notifyResult(second);
    assert(f.calls.length === 2 + Number(clickup==='fail') + Number(drive==='fail'),'only explicit failed branches retried');
    assert(f.resources.filter(b=>b==='clickup').length===1 && f.resources.filter(b=>b==='drive').length===1,'no duplicate resources');
    const before = f.calls.length;
    notifyResult(await onboardCustomer(store,create,'fixture'));
    assert(f.calls.length===before,'completed and uncertain outcomes are durable in the fixture store');
    assert(summaries.size === (clickup==='fail'||drive==='fail' ? 2 : 1),'one summary per distinct settled outcome');
    cases.push({name:name+' and partial retry',passed:true});
  }
  const provider=onboardingFixtureProvider();
  const resumed=await onboardCustomer(memoryOnboardingStore({drive:{status:'dispatching'}}),onboardingTransport(setup,customer,async()=>'synthetic',()=>{},provider.fetchImpl),'fixture');
  assert(resumed.outcomes.drive.status==='unknown' && provider.calls.join(',')==='clickup','interrupted writes not repeated');
  cases.push({name:'interrupted branch requires review while other branch completes',passed:true});
  return {passed:true,definitionDigest:digest(trigger),cases,externalActions:0,scope:'Saved graph component fixtures: real coordinator, transport request shapes, expressions and synthetic provider outcomes. In-memory receipts and notification sink only. Durable SQLite, worker, Authority, account binding, dashboard transport and live providers are not exercised here; repository integration tests cover the first four separately.',configuration:'Synthetic deferred setup only; saved draft unchanged; no credentials resolved'};
}
