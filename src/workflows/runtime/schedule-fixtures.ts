import { fileURLToPath } from 'node:url';
import { CronScheduler, cronWallTimeKey, validateCronExpression, validateCronTimezone } from '../../lib/cron-scheduler';
import { scheduleTriggerPayload } from './schedule-payload';
import { resolveFixtureValue } from './json-mapping-fixtures';
import { digest } from './effect-context';

function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error('Schedule fixture: ' + message); }
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
function instant(value: unknown): number {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value), 'use ISO timestamps with explicit offsets');
  const ms = Date.parse(value); check(Number.isFinite(ms), 'invalid timestamp'); return ms;
}
function prepare(saved: any, fixture: any) {
  check(JSON.stringify({saved, fixture}).length <= 200_000, 'input exceeds 200 KB');
  check(saved?.type === 'PIECE_TRIGGER' && saved.settings?.pieceName === 'schedule', 'requires built-in schedule');
  const input = saved.settings.input ?? {}, expression = input.cron_expression || input.cronExpression || input.expression;
  check(typeof expression === 'string' && !expression.startsWith('@'), 'requires a configured five-field cron');
  validateCronExpression(expression); validateCronTimezone(input.timezone);
  const node = saved.nextAction;
  check(node?.type === 'PIECE' && ['@jarvispieces/piece-jarvis-notify','jarvis-notify'].includes(node.settings?.pieceName)
    && node.settings.actionName === 'notify' && !node.nextAction && !node.firstLoopAction && !node.children?.length
    && !saved.firstLoopAction && !saved.children?.length, 'supports only schedule -> dashboard notify; other graph shapes are not covered');
  check(!node.settings.propertySettings || Object.keys(node.settings.propertySettings).length === 0, 'property processors unsupported');
  check(!node.settings.continueOnFailure && !node.settings.retryOnFailure
    && !node.settings.errorHandlingOptions?.continueOnFailure?.value && !node.settings.errorHandlingOptions?.retryOnFailure?.value, 'retry/continue settings unsupported');
  check(object(fixture) && Array.isArray(fixture.cases) && fixture.cases.length > 0 && fixture.cases.length <= 40, 'supply 1-40 fixture_input.cases');
  for (const c of fixture.cases) {
    check(typeof c.name === 'string' && typeof c.expectedMatch === 'boolean', 'each case needs name and expectedMatch');
    const at = instant(c.scheduledFor), executedAt = instant(c.executedAt ?? c.scheduledFor);
    check(at % 60_000 === 0 && executedAt >= at, 'scheduledFor must be a whole minute; executedAt must not precede it');
    check(c.notificationOutcome === undefined || ['success','failure','uncertain'].includes(c.notificationOutcome), 'invalid notificationOutcome');
    check(c.expectedKey === undefined || typeof c.expectedKey === 'string', 'expectedKey must be a string');
  }
  return {node, expression, timezone: input.timezone};
}

async function runCases(saved: any, fixture: any) {
  const {node,expression,timezone} = prepare(saved,fixture);
  // Fixed local implementation only. No account binding or daemon URL is used.
  const { sendNotification } = await import('../activepieces/packages/pieces/jarvis/notify/src/lib/actions/send-notification');
  const cases = [];
  for (const c of fixture.cases) {
    const at = instant(c.scheduledFor), executedAt = instant(c.executedAt ?? c.scheduledFor);
    const matches = CronScheduler.matchesIn(expression, new Date(at), timezone);
    check(matches === c.expectedMatch, c.name + ': schedule match differs');
    let request: any, status = 'NOT_SCHEDULED', error: string | undefined;
    let trigger: ReturnType<typeof scheduleTriggerPayload> | undefined;
    if (matches) {
      // Serialization simulates the stored payload boundary; real SQLite/worker recovery is tested separately.
      trigger = JSON.parse(JSON.stringify(scheduleTriggerPayload({cronExpression:expression,timezone}, {at,key:cronWallTimeKey(new Date(at),timezone),lateMs:0}, at)));
      const input = resolveFixtureValue(node.settings.input, {[saved.name]:trigger});
      check(Array.isArray(input.channels) && input.channels.length === 1 && input.channels[0] === 'dashboard', 'only dashboard transport can be mocked');
      check(!input.meetingGuard, 'meeting guards require their own fixture suite');
      check(typeof input.message === 'string' && input.message.length > 0, 'notification message required');
      check(typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim().length > 0, 'stable notification key required');
      if(c.expectedKey !== undefined) check(input.idempotencyKey === c.expectedKey, c.name + ': notification key differs');
      globalThis.fetch = (async (url: any, init: any) => {
        check(url === 'http://fixture.invalid/v1/jarvis/notify' && init?.method === 'POST', 'unexpected network request');
        check(!request, 'multiple dispatches'); request = JSON.parse(init.body);
        if (c.notificationOutcome === 'uncertain') throw Error('fixture-response-lost');
        return c.notificationOutcome === 'failure' ? new Response('fixture rejected', {status:503})
          : Response.json({delivered:['dashboard'],failed:[],unknown:[]});
      }) as typeof fetch;
      try {
        await sendNotification({propsValue:input,server:{apiUrl:'http://fixture.invalid',token:'synthetic-fixture'},step:{name:node.name},executionPath:[],run:{id:'fixture-run',waitForWaitpoint:()=>{throw Error('Unexpected approval');}}} as any);
        status = 'SUCCEEDED';
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        check(!!request && (c.notificationOutcome === 'failure' && error.includes('503') || c.notificationOutcome === 'uncertain' && error.includes('fixture-response-lost')), 'unexpected action failure: ' + error);
        status = c.notificationOutcome === 'uncertain' ? 'UNCERTAIN' : 'FAILED';
      }
      check(status === (c.notificationOutcome === 'failure' ? 'FAILED' : c.notificationOutcome === 'uncertain' ? 'UNCERTAIN' : 'SUCCEEDED'), c.name + ': status differs');
    }
    cases.push({name:c.name,passed:true,scheduledFor:c.scheduledFor,executedAt:new Date(executedAt).toISOString(),matches,status,trigger,request,error});
  }
  return {passed:true,definitionDigest:digest(saved),cases,externalActions:0,
    scope:'Saved-graph component fixtures: production cron matcher, serialized scheduled payload, expression resolver and actual notify transport with mocked responses. Not end-to-end.',
    limitations:'No durable SQLite/worker restart, Authority, live dashboard transport or persistent notification deduplication tested. Delayed evaluation reuses serialized occurrence values; no arbitrary code/JSONata supported.',
    configuration:'Saved graph, accounts, activation and workflow runs unchanged.'};
}

/** Isolated, bounded runner: no credentials or real network. */
export async function validateScheduleFixtures(saved: any, fixture: any) {
  prepare(saved, fixture);
  const child = Bun.spawn([process.execPath,'--no-env-file',fileURLToPath(import.meta.url)], {
    env:{},stdin:new Blob([JSON.stringify({saved,fixture})]),stdout:'pipe',stderr:'ignore',
  });
  let timedOut = false;
  const timer = setTimeout(()=>{timedOut=true;child.kill();},10_000);
  try {
    const chunks: Uint8Array[] = []; let size=0;
    const reader=child.stdout.getReader();
    for (;;) { const {done,value}=await reader.read();if(done)break;size+=value.length;check(size<=1_000_000,'output exceeds 1 MB');chunks.push(value); }
    const code=await child.exited;check(!timedOut,'execution timed out');
    const result=JSON.parse(Buffer.concat(chunks).toString());check(code===0 && result.ok,result.error ?? 'execution failed');return result.report;
  } finally { clearTimeout(timer);child.kill(); }
}
if(import.meta.main){
  globalThis.fetch=(()=>{throw Error('Real network disabled in schedule fixtures');}) as unknown as typeof fetch;
  try { const {saved,fixture}=await Bun.stdin.json();console.log(JSON.stringify({ok:true,report:await runCases(saved,fixture)})); }
  catch(e){console.log(JSON.stringify({ok:false,error:e instanceof Error?e.message:String(e)}));process.exitCode=1;}
}
