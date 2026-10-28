import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { digest } from './effect-context';
import { evaluateWorkflowExpression, workflowInterpolationText } from './safe-expression';
import { prepareSubmission, submissionConfig } from './form-submission';

const JSON_PIECE = '@activepieces/piece-json';
const SHEETS = '@activepieces/piece-google-sheets';
const RETURN = '@jarvispieces/piece-jarvis-subflow';
const pureActions = ['convert_text_to_json', 'convert_json_to_text', 'run_jsonata_query'];
const conditionOperators = ['BOOLEAN_IS_TRUE','BOOLEAN_IS_FALSE','TEXT_EXACTLY_MATCHES',
  'NUMBER_IS_GREATER_THAN','NUMBER_IS_LESS_THAN','NUMBER_IS_EQUAL_TO'];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw Error('JSON mapping fixture: ' + message); }
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const empty = (value: unknown) => value === undefined || value === null || value === '';

// Match the engine's typed whole-token resolution and text interpolation.
export function resolveFixtureValue(value: any, scope: Record<string, unknown>): any {
  if (typeof value === 'string') {
    const pattern = /\{\{(.*?)\}\}/g, matches = [...value.matchAll(pattern)];
    const evaluate = (expression: string) => {
      const result = evaluateWorkflowExpression(expression, scope);
      check(result !== undefined, 'reference resolved to an absent value');
      return result ?? '';
    };
    if (matches.length === 1 && matches[0]![0] === value) return evaluate(matches[0]![1]!);
    check(!/\{\{\s*flattenNestedKeys/.test(value), 'mixed flattenNestedKeys requires engine validation');
    return value.replace(pattern, (_, expression) => workflowInterpolationText(evaluate(expression)));
  }
  if (Array.isArray(value)) return value.map(item => resolveFixtureValue(item, scope));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFixtureValue(item, scope)]));
  return value;
}

function prepare(saved: any, fixture: any) {
  check(object(fixture) && Array.isArray(fixture.cases) && fixture.cases.length > 0 && fixture.cases.length <= 40, 'supply 1-40 cases');
  check(JSON.stringify({saved, fixture}).length <= 200_000, 'input exceeds 200 KB');
  const graph = structuredClone(saved), nodes = new Map<string, any>();
  check(graph?.type === 'PIECE_TRIGGER' && graph.settings?.pieceName === 'webhook'
    && Object.keys(graph.settings.input ?? {}).every(key => key === 'request_id_field'), 'requires a plain or request-ID-only webhook');
  const scan = (node: any) => {
    if (!node) return;
    check(nodes.size < 40 && typeof node.name === 'string' && !nodes.has(node.name), 'graph too large or duplicate node');
    nodes.set(node.name, node);
    check(!Object.keys(node.settings?.propertySettings ?? {}).length, 'custom property processors unsupported');
    check(!node.firstLoopAction && !node.settings?.continueOnFailure && !node.settings?.retryOnFailure
      && !node.settings?.errorHandlingOptions?.continueOnFailure?.value && !node.settings?.errorHandlingOptions?.retryOnFailure?.value, 'loop/retry/continue settings unsupported');
    if (node !== graph) {
      if (node.type === 'ROUTER') {
        check(node.settings?.executionType === 'EXECUTE_FIRST_MATCH' && Array.isArray(node.children) && node.children.length === node.settings.branches?.length, 'requires first-match router');
        check(node.settings.branches.at(-1)?.branchType === 'FALLBACK', 'requires last fallback');
        for (const branch of node.settings.branches.slice(0,-1)) {
          check(branch.branchType === 'CONDITION' && Array.isArray(branch.conditions), 'invalid condition branch');
          for (const group of branch.conditions) for (const c of group) check(conditionOperators.includes(c.operator), 'unsupported condition ' + String(c.operator));
        }
      } else {
        const {pieceName, actionName} = node.settings ?? {};
        check(node.type === 'PIECE' && (pieceName === JSON_PIECE && pureActions.includes(actionName)
          || pieceName === SHEETS && actionName === 'sheets_append_values'
          || pieceName === RETURN && actionName === 'return_result'), 'unsupported action ' + node.name);
        check(!node.children?.length, 'action cannot have branches');
      }
    }
    for (const child of node.children ?? []) scan(child);
    scan(node.nextAction);
  };
  scan(graph);
  const substitutions: string[] = [];
  for (const [name, values] of Object.entries(fixture.setup ?? {})) {
    const node = nodes.get(name);
    check(node && object(values), 'unknown setup node');
    node.settings.input ??= {};
    for (const [key, value] of Object.entries(values)) {
      check((Object.hasOwn(node.settings.input, key) || key === 'auth' && node.settings.pieceName === SHEETS) && empty(node.settings.input[key]), 'setup may replace only empty inputs: ' + name + '.' + key);
      node.settings.input[key] = value; substitutions.push(name + '.' + key);
    }
  }
  const admission = submissionConfig(graph.settings.input);
  return {graph, substitutions, admission, nodes};
}

/** Executes only allowlisted pure JSON actions, with no network-capable actions loaded. */
async function runCases(saved: any, fixture: any) {
  const {graph, substitutions, admission, nodes} = prepare(saved, fixture);
  const {json} = createRequire(import.meta.url)(JSON_PIECE);
  const cases = [];
  for (const c of fixture.cases) {
    check(typeof c.name === 'string' && Object.hasOwn(c, 'payload') && Array.isArray(c.expectedRows)
      && ['SUCCEEDED','REJECTED','FAILED','UNCERTAIN'].includes(c.expectedStatus), 'each case needs payload, expectedRows and expectedStatus');
    check(c.sheetsOutcome === undefined || ['success','failure','uncertain'].includes(c.sheetsOutcome), 'invalid sheetsOutcome');
    check(c.sheetsOutcomes === undefined || object(c.sheetsOutcomes), 'sheetsOutcomes must map step names to outcomes');
    for (const [name,outcome] of Object.entries(c.sheetsOutcomes ?? {})) {
      check(nodes.get(name)?.settings?.pieceName === SHEETS && ['success','failure','uncertain'].includes(String(outcome)), 'invalid Sheets step outcome');
    }
    const deliveries = c.deliveries ?? 1;
    check(Number.isInteger(deliveries) && deliveries >= 1 && deliveries <= 20, 'deliveries must be 1-20');
    const scope: Record<string, any> = {trigger: c.payload}, steps: string[] = [], rows: any[] = [], requests: any[] = [];
    const rowsByStep: Record<string, any[]> = {}, requestsByStep: Record<string, number> = {};
    const admitted = new Set<string>(); let duplicateDeliveries = 0, rejectedDeliveries = 0;
    let returned: any, status = 'SUCCEEDED', error: string | undefined;
    const visit = async (node: any): Promise<void> => {
      if (!node) return;
      if (node.type === 'ROUTER') {
        const index = node.settings.branches.findIndex((b: any) => b.branchType === 'FALLBACK' || b.conditions.some((group: any[]) => group.every(condition => {
          const a = resolveFixtureValue(condition.firstValue, scope);
          if (condition.operator === 'BOOLEAN_IS_TRUE') return !!a;
          if (condition.operator === 'BOOLEAN_IS_FALSE') return !a;
          if (condition.operator.startsWith('NUMBER_')) {
            // Same parseStringToNumber semantics as the production router:
            // numeric strings are parsed; nonnumeric strings remain strings.
            // This compares route operands, never coerces product fields.
            const parse = (value: any) => Number.isNaN(Number(value)) ? value : Number(value);
            const left = parse(a), right = parse(resolveFixtureValue(condition.secondValue, scope));
            if (condition.operator === 'NUMBER_IS_GREATER_THAN') return left > right;
            if (condition.operator === 'NUMBER_IS_LESS_THAN') return left < right;
            return left == right;
          }
          const first = workflowInterpolationText(a), second = workflowInterpolationText(resolveFixtureValue(condition.secondValue, scope));
          return condition.caseSensitive ? first === second : first.toLowerCase() === second.toLowerCase();
        })));
        check(index >= 0, 'no matching branch');
        await visit(node.children[index]);
      } else {
        steps.push(node.name);
        const {pieceName, actionName} = node.settings;
        // Never resolve saved connection references, even when already bound.
        const input = resolveFixtureValue({...node.settings.input, ...(pieceName === SHEETS ? {auth: 'fixture-only'} : {})}, scope);
        if (pieceName === JSON_PIECE) {
          if (actionName === 'convert_text_to_json') input.text = workflowInterpolationText(input.text);
          if (actionName === 'run_jsonata_query') input.query = workflowInterpolationText(input.query);
          scope[node.name] = await json.actions()[actionName].run({propsValue: input});
        } else if (pieceName === SHEETS) {
          for (const key of ['spreadsheet_id','worksheet_title','range']) check(!empty(input[key]), 'fixture setup missing ' + key);
          check(input.value_input_option === 'RAW', 'RAW required for value-preservation fixtures');
          check(Array.isArray(input.values) && input.values.every((row: any) => Array.isArray(row) && row.every((v: any) => v === null || ['string','boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v))), 'values must be a typed 2D array');
          // This is the inspected append request shape; transport is a mock.
          requests.push({step: node.name, spreadsheetId: input.spreadsheet_id, range: "'" + String(input.worksheet_title).replace(/'/g,"''") + "'!" + input.range,
            valueInputOption: input.value_input_option, insertDataOption: 'INSERT_ROWS', requestBody: {majorDimension: 'ROWS', values: input.values}});
          requestsByStep[node.name] = (requestsByStep[node.name] ?? 0) + 1;
          const outcome = c.sheetsOutcomes?.[node.name] ?? c.sheetsOutcome;
          if (outcome === 'failure') throw Error('Mock Sheets rejected append: ' + node.name);
          rows.push(...input.values);
          (rowsByStep[node.name] ??= []).push(...input.values);
          if (outcome === 'uncertain') { status = 'UNCERTAIN'; throw Error('Mock Sheets response lost after append: ' + node.name); }
          scope[node.name] = {updatedRange: 'Fixture!A1:C1', updatedRows: input.values.length};
        } else {
          returned = input.result;
          scope[node.name] = input.result;
          if (returned?.valid === false) status = 'REJECTED';
        }
      }
      await visit(node.nextAction);
    };
    // Concurrent same-case deliveries share a synthetic admission set. This
    // uses production normalization but does not claim to test SQLite locking.
    await Promise.all(Array.from({length: deliveries}, async () => {
      if (admission) {
        let prepared;
        try { prepared = prepareSubmission(c.payload, admission); }
        catch (e) { rejectedDeliveries++; status = 'REJECTED'; error = (e as Error).message; return; }
        if (admitted.has(prepared.key)) { duplicateDeliveries++; return; }
        admitted.add(prepared.key); scope.trigger = prepared.data;
      } else check(deliveries === 1, 'multiple deliveries require request-ID admission');
      try { await visit(graph.nextAction); }
      catch (e) { if (status !== 'UNCERTAIN') status = 'FAILED'; error = e instanceof Error ? e.message : String(e); }
    }));
    check(status === c.expectedStatus, c.name + ': expected ' + c.expectedStatus + ', observed ' + status + (error ? ': ' + error : ''));
    check(isDeepStrictEqual(rows, c.expectedRows), c.name + ': typed row values differ: ' + JSON.stringify(rows));
    if (c.expectedSteps !== undefined) check(isDeepStrictEqual(steps, c.expectedSteps), c.name + ': executed steps differ');
    if (c.expectedStates !== undefined) check(isDeepStrictEqual(JSON.parse(JSON.stringify(returned?.states ?? null)), c.expectedStates), c.name + ': field states differ');
    if (c.expectedIssues !== undefined) check(isDeepStrictEqual(returned?.issues, c.expectedIssues), c.name + ': rejection issues differ');
    if (c.expectedError !== undefined) check(error?.includes(c.expectedError), c.name + ': expected error not observed');
    if (c.expectedRequests !== undefined) check(requests.length === c.expectedRequests, c.name + ': request count differs');
    if (c.expectedDuplicateDeliveries !== undefined) check(duplicateDeliveries === c.expectedDuplicateDeliveries, c.name + ': duplicate delivery count differs');
    if (c.expectedAdmissionRejections !== undefined) check(rejectedDeliveries === c.expectedAdmissionRejections, c.name + ': admission rejection count differs');
    for (const [step,expected] of Object.entries(c.expectedRowsByStep ?? {}))
      check(isDeepStrictEqual(rowsByStep[step] ?? [], expected), c.name + ': rows differ for ' + step);
    for (const [step,expected] of Object.entries(c.expectedRequestsByStep ?? {}))
      check((requestsByStep[step] ?? 0) === expected, c.name + ': request count differs for ' + step);
    // Assert arbitrary structured results without guessing the domain meaning
    // of a status string or treating a completed rejection branch as a failure.
    for (const assertion of c.assertions ?? []) {
      check(object(assertion) && typeof assertion.step === 'string' && Array.isArray(assertion.path)
        && assertion.path.every((key: unknown) => typeof key === 'string' || Number.isSafeInteger(key))
        && Object.hasOwn(assertion,'equals'), 'assertions require step, path and equals');
      let actual: any = scope[assertion.step];
      for (const key of assertion.path) {
        check(actual !== null && typeof actual === 'object' && Object.hasOwn(actual,key), c.name + ': asserted path absent');
        actual = actual[key];
      }
      check(actual !== undefined && isDeepStrictEqual(JSON.parse(JSON.stringify(actual)),assertion.equals), c.name + ': output assertion differs at ' + assertion.step + '.' + assertion.path.join('.'));
    }
    cases.push({name: c.name, passed: true, status, steps, rows, rowsByStep, requests, duplicateDeliveries, rejectedDeliveries, ...(returned === undefined ? {} : {result: returned}), ...(error ? {error} : {})});
  }
  return {passed: true, definitionDigest: digest(saved), cases, substitutions, externalActions: 0,
    jsonConnectorVersion: '0.1.14',
    scope: 'Saved-graph component fixtures: actual pinned JSON connector actions (including JSONata), production template expressions and ID normalization, in-memory admission, first-match routing and per-step mocked Sheets append requests. Not an end-to-end test.',
    limitations: 'No live accounts, provider transport, durable worker/receipts, Authority or webhook HTTP rejection response tested. Duplicate deliveries use a synthetic in-memory claim, not durable recovery. Unknown writes are reported as uncertain; receipt replay/retry recovery is not simulated.',
    configuration: 'Setup substituted only in memory. Saved graph, credentials, activation and workflow runs are unchanged.'};
}

/** A separate, time-bounded process prevents an arbitrary JSONata expression
 * from blocking the daemon. Only allowlisted pure actions are executable. */
export async function validateJsonMappingFixtures(saved: any, fixture: any) {
  prepare(saved, fixture);
  const child = Bun.spawn([process.execPath, '--no-env-file', fileURLToPath(import.meta.url)], {
    env: {}, stdin: new Blob([JSON.stringify({saved, fixture})]), stdout: 'pipe', stderr: 'ignore',
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 10_000);
  try {
    const reader = child.stdout.getReader(), chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1_000_000) { child.kill(); throw Error('JSON mapping fixture: output exceeds 1 MB'); }
      chunks.push(value);
    }
    const code = await child.exited;
    check(!timedOut, 'execution timed out');
    const result = JSON.parse(Buffer.concat(chunks).toString());
    check(code === 0 && result.ok, result.error ?? 'execution failed');
    return result.report;
  } finally { clearTimeout(timer); child.kill(); }
}

if (import.meta.main) {
  globalThis.fetch = (() => { throw Error('Network disabled in JSON mapping fixtures'); }) as unknown as typeof fetch;
  try {
    const {saved, fixture} = await Bun.stdin.json();
    console.log(JSON.stringify({ok: true, report: await runCases(saved, fixture)}));
  } catch (e) {
    console.log(JSON.stringify({ok: false, error: e instanceof Error ? e.message : String(e)}));
    process.exitCode = 1;
  }
}
