import { prepareSubmission, submissionConfig } from './form-submission';
import { evaluateWorkflowExpression, workflowInterpolationText } from './safe-expression';
import { digest } from './effect-context';

const CLICKUP = '@activepieces/piece-clickup';
const assert = (ok: unknown, message: string): void => { if (!ok) throw Error('Routing fixture: ' + message); };
const object = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const empty = (v: unknown) => v === null || v === undefined || v === '';

/** Bounded component harness, never a workflow runner. Only expressions and
 * ingress normalization use production code. Dispatch/admission are mocks;
 * durable receipt and worker behavior have separate real-engine tests. */
export async function validateSupportRoutingFixtures(saved: any, fixture: any) {
  assert(object(fixture) && Array.isArray(fixture.cases) && fixture.cases.length > 0 && fixture.cases.length <= 40, 'supply 1-40 explicit cases');
  assert(JSON.stringify(fixture).length <= 100_000, 'fixture input too large');
  assert(saved?.type === 'PIECE_TRIGGER' && saved.settings?.pieceName === 'webhook', 'only webhook routing is supported');
  const graph = structuredClone(saved), nodes = new Map<string, any>();
  const scan = (n: any) => {
    if (!n) return;
    assert(nodes.size < 60 && typeof n.name === 'string' && !nodes.has(n.name), 'duplicate nodes or graph too large'); nodes.set(n.name, n);
    assert(!n.firstLoopAction && !n.settings?.continueOnFailure && !n.settings?.retryOnFailure, 'loops and explicit retry settings are unsupported');
    if (n !== graph) {
      if (n.type === 'ROUTER') assert(n.settings?.executionType === 'EXECUTE_FIRST_MATCH' && Array.isArray(n.children) && n.children.length === n.settings.branches?.length, 'router must be first-match with matching children');
      else assert(n.type === 'PIECE' && ((n.settings?.pieceName === CLICKUP && ['create_task','clickup_create_task'].includes(n.settings.actionName)) || (['jarvis-notify','@jarvispieces/piece-jarvis-notify'].includes(n.settings?.pieceName) && n.settings.actionName === 'notify')), 'unsupported action ' + n.name);
    }
    for (const child of n.children ?? []) scan(child);
    scan(n.nextAction);
  };
  scan(graph);
  const substitutions: string[] = [];
  for (const [name, values] of Object.entries(fixture.setup ?? {})) {
    const n = nodes.get(name); assert(n && object(values), 'unknown setup node');
    n.settings ??= {}; n.settings.input ??= {};
    for (const [key,value] of Object.entries(values as object)) {
      // Auth is a virtual mock input, not a saved account binding. The editor
      // and composer legitimately omit it on unconnected drafts.
      const omittedAuth = key === 'auth' && n.settings?.pieceName === CLICKUP;
      assert((Object.hasOwn(n.settings.input,key) || omittedAuth) && empty(n.settings.input[key]), 'setup can replace only empty inputs (or omitted ClickUp auth): ' + name + '.' + key);
      n.settings.input[key] = value; substitutions.push(name + '.' + key);
    }
  }
  const config = submissionConfig(graph.settings.input);
  assert(config && !config.emailField && 'request_id_field' in graph.settings.input, 'requires request-ID-only admission');
  const resolve = (value: any, context: Record<string, unknown>): any => {
    if (typeof value === 'string') {
      const pattern = /\{\{(.*?)\}\}/g, matches = [...value.matchAll(pattern)];
      const evaluate = (expression: string) => {
        const result = evaluateWorkflowExpression(expression, context);
        if (result === undefined) throw Error('Workflow reference resolved to an absent value; supply a value or an explicit fallback');
        return result ?? ''; // Same null/absent semantics as the engine resolver.
      };
      if (matches.length === 1 && matches[0]![0] === value) return evaluate(matches[0]![1]!);
      assert(!/\{\{\s*flattenNestedKeys/.test(value), 'mixed flattenNestedKeys templates require the engine fixture suite');
      return value.replace(pattern, (_, expression) => workflowInterpolationText(evaluate(expression)));
    }
    if (Array.isArray(value)) return value.map(v => resolve(v, context));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,resolve(v,context)]));
    return value;
  };
  const condition = (c: any, context: Record<string,unknown>) => {
    const a = resolve(c.firstValue, context), b = resolve(c.secondValue, context);
    switch(c.operator) {
      case 'BOOLEAN_IS_TRUE': return !!a;
      case 'BOOLEAN_IS_FALSE': return !a;
      case 'TEXT_EXACTLY_MATCHES': {
        const first = workflowInterpolationText(a), second = workflowInterpolationText(b);
        return c.caseSensitive ? first === second : first.toLowerCase() === second.toLowerCase();
      }
      default: throw Error('Routing fixture: unsupported condition ' + c.operator);
    }
  };
  const results = [];
  for (const c of fixture.cases) {
    assert(object(c) && typeof c.name === 'string' && object(c.payload) && Array.isArray(c.expectedSteps) && Number.isInteger(c.expectedTaskCount), 'each case needs payload and explicit expectations');
    const deliveries = c.deliveries ?? 1;
    assert(Number.isInteger(deliveries) && deliveries >= 1 && deliveries <= 20, 'deliveries must be 1-20');
    const admitted = new Set<string>(), steps: string[] = [], tasks: any[] = [], notifications: any[] = [];
    assert(c.expectedRejection === undefined || typeof c.expectedRejection === 'boolean', 'expectedRejection must be boolean');
    let uncertain = false, duplicates = 0, rejected = 0;
    const visit = (n: any, context: Record<string,unknown>) => {
      if (!n) return;
      if (n.type === 'ROUTER') {
        const branches = n.settings.branches;
        const index = branches.findIndex((b: any) => b.branchType === 'FALLBACK' || b.conditions.some((group: any[]) => group.every(item => condition(item,context))));
        assert(index >= 0, 'no branch matched'); visit(n.children[index],context);
      } else {
        steps.push(n.name);
        // Never resolve a connection expression or require real credentials
        // for this network-free component harness, whether auth is absent,
        // null, or already configured. Saved inputs remain unchanged.
        const input = resolve({...n.settings.input,auth:'synthetic-fixture-connection'},context);
        if (n.settings.pieceName === CLICKUP) {
          // These inspected ClickUp properties use the engine text processor:
          // whole-token objects also become JSON text at the property boundary.
          for(const key of ['name','description']) if(input[key] != null){
            input[key] = workflowInterpolationText(input[key]);
            if(key === 'description' && input[key] === '') input[key] = undefined;
          }
          for (const key of ['auth','workspace_id','space_id','list_id','name']) assert(!empty(input[key]), 'fixture setup missing ' + n.name + '.' + key);
          tasks.push(input);
          if (c.loseReply) { uncertain = true; throw Error('fixture-lost-reply'); }
          context[n.name] = {id:'fixture-task-' + tasks.length};
        } else {
          assert(Array.isArray(input.channels) && input.channels.length === 1 && input.channels[0] === 'dashboard', 'only dashboard notifications can be mocked');
          notifications.push(input); context[n.name] = {delivered:['dashboard']};
        }
      }
      visit(n.nextAction,context);
    };
    // Each test owns synthetic admission state. Same-case deliveries contend
    // on one key; persistence/restart is expressly outside this component suite.
    await Promise.all(Array.from({length:deliveries}, async () => {
      let p: ReturnType<typeof prepareSubmission>;
      try { p = prepareSubmission(c.payload,config!); }
      catch (error) {
        if (!c.expectedRejection) throw error;
        rejected++; return;
      }
      if (admitted.has(p.key)) { duplicates++; return; }
      admitted.add(p.key);
      try { visit(graph.nextAction,{trigger:p.data}); }
      catch(error) { if (!(c.loseReply && (error as Error).message === 'fixture-lost-reply')) throw error; }
    }));
    assert(JSON.stringify(steps) === JSON.stringify(c.expectedSteps), c.name + ': unexpected executed actions: ' + JSON.stringify(steps));
    assert(tasks.length === c.expectedTaskCount, c.name + ': task count ' + tasks.length);
    if (c.expectedPriority !== undefined) {
      // Catalog dropdown choices are represented as strings in saved input
      // schemas; accept the same declared choice in its numeric form as well.
      const actual = tasks[0]?.priority_id;
      assert(tasks.length === 1 && ['number','string'].includes(typeof actual) && ['number','string'].includes(typeof c.expectedPriority)
        && String(actual) === String(c.expectedPriority),c.name + ': wrong priority');
    }
    if (c.expectedDescription !== undefined) assert(tasks.length === 1 && tasks[0].description === c.expectedDescription,c.name + ': wrong task description');
    assert(uncertain === !!c.loseReply,c.name + ': uncertain result mismatch');
    assert(rejected === (c.expectedRejection ? deliveries : 0), c.name + ': admission rejection mismatch');
    results.push({name:c.name,passed:true,steps,tasks:tasks.length,notifications:notifications.length,duplicateDeliveries:duplicates,rejectedDeliveries:rejected,uncertain});
  }
  return {passed:true,definitionDigest:digest(saved),cases:results,externalActions:0,substitutions,
    scope:'Saved-graph component fixtures: production expression interpreter and ID normalization; mocked ClickUp/dashboard dispatch and in-memory admission. No live network, account access or activation.',
    limitations:'Not an end-to-end execution. Durable database admission, real worker/engine, Authority UI, provider HTTP behavior, restart and receipt recovery are not exercised by this tool suite. They require separate repository integration tests.',
    configuration:'Synthetic setup and mock authentication substituted only in memory; saved workflow unchanged. No account bindings or credentials are read'};
}
