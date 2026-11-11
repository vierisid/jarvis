import { isZoomReference, zoomInputSchema } from "./managed-zoom-inputs";
import { isPipedriveReference, pipedriveInputSchema } from "./managed-pipedrive-inputs";
import { isWrikeReference, wrikeInputSchema } from "./managed-wrike-inputs";
import { isHelpScoutReference, helpScoutInputSchema } from "./managed-help-scout-inputs";
import { isGitLabReference, gitlabInputSchema } from "./managed-gitlab-inputs";
import { isMondayReference, mondayInputSchema } from "./managed-monday-inputs";
import {managedAirtableIssue} from './managed-airtable';
import { MEETING_ACCOUNTS, meetingSetup } from './meeting-briefs';
import { MANAGED_HUBSPOT_REFUSAL } from '../meeting-accounts';
import { REFUND_REQUIRED, refundSetup } from './refund';
import { walkFlowNodes } from '../db/flow-graph';
import { workflowToolRefusal, workflowUiStepRefusals, type WorkflowMachineView } from './workflow-ui-tools';
import type { FlowTriggerNode } from '../db/repos/flow-version';
import { REFUND_ACCOUNTS, REFUND_LOOP_REFUSAL, REFUND_PIECE, isRefundAction, managedRefundRefusal, type RefundAccountField } from '../refund-accounts';
import { IMPORT_REQUIRED, importSetup } from './contact-import';
import { IMPORT_ACCOUNTS, IMPORT_PIECE, importAccountFields, isImportStep, managedImportRefusal } from '../import-accounts';
import { REPORT_REQUIRED, reportSetup } from './weekly-report';
import { REPORT_ACCOUNTS, REPORT_PIECE, isReportStep, managedReportRefusal, type ReportAccountField, QUARTERLY_ACCOUNTS, QUARTERLY_MANAGED_REFUSAL, isQuarterlyReportStep } from '../report-accounts';
import { QUARTERLY_REQUIRED, QUARTERLY_ZONE, quarterlySetup } from './quarterly-report';
import { SALES_ACCOUNTS, SALES_REQUIRED, SALES_PIECE, isSalesStep, salesSetup } from './sales-followups';
import { ONBOARDING_REQUIRED, onboardingSetup } from './customer-onboarding';
import { ONBOARDING_ACCOUNTS, ONBOARDING_PIECE, isOnboardingStep } from '../onboarding-accounts';
import { BATCH_REQUIRED, batchSetup, batchGraphError } from './lead-batch';
import { BATCH_ACCOUNTS, BATCH_PIECE, isBatchStep } from '../batch-accounts';
import { isWebflowReference, webflowInputSchema } from './managed-webflow-inputs';
import { parseOutputSchema } from './llm-output-contract';
import { submissionConfig } from './form-submission';
import {managedNotionIssue} from './managed-notion';
import {managedMailchimpIssue} from './managed-mailchimp';
import {managedGitHubIssue} from './managed-github';
import {managedTrelloIssue} from './managed-trello';
import {managedSlackIssue} from './managed-slack';
import { validateCronExpression, validateCronTimezone, validateCronDstPolicy } from '../../lib/cron-scheduler';
import { propsToInputSchema, type PieceLookup, type PieceCatalogAction } from './piece-catalog';
import { evaluateWorkflowExpression, workflowExpressionGuardedReferences, workflowExpressionHasComputedKey, workflowExpressionReferences } from './safe-expression';
import { emptyInput, inputIssue } from './input-validation';
import { declaredDependencies } from './code-step-manifest';
import { canonicalZone, chosenScheduleZone, effectiveScheduleZone, statedScheduleZone } from '../runner/triggers/schedule-zone';

export interface ReadinessIssue {
  node: string;
  path: string;
  code: string;
  message: string;
  /** For a managed connection named by the wrong step: the pieces (by full name) that may use it. */
  allowedPieces?: string[];
}
/** A connection refusal; `allowedPieces` is copied onto the issue for tooling. */
export interface ConnectionRefusal {
  message: string;
  allowedPieces?: readonly string[];
}
export interface RuntimeCheck extends ReadinessIssue {
  /** The boundary responsible for checking actual data before dispatch. */
  guard: 'expression' | 'piece-input' | 'tool-input' | 'loop-items' | 'connection' | 'workflow-binding';
}
export interface WorkflowReadiness {
  ready: boolean;
  issues: ReadinessIssue[];
  runtimeChecks: RuntimeCheck[];
  /** Missing user configuration accepted only during disabled-draft composition. */
  setupIssues?: ReadinessIssue[];
}
export interface ReadinessContext {
  pieces?: PieceLookup;
  /** Composition may leave bindings for the editor; activation may not. */
  phase?: 'composition' | 'activation';
  /** Single-step engine execution; bindings on other draft nodes are not used. */
  preview?: { stepName: string; inputOverride?: Record<string, unknown> };
  /**
   * `pieceName` is empty for a step that is not a piece step; `path` is where
   * the step names the connection; `settings` are the step's settings (with a
   * preview's input override applied).
   */
  connection?: (externalId: string, pieceName: string, path: string, settings: Record<string, unknown>, nodeType?: unknown) => string | ConnectionRefusal | null;
  workflow?: (id: string) => string | null;
  tool?: (name: string) => { params: Array<{ name: string; type: string; required: boolean; enum?: string[] }>; workflowRefusal?: string | null;
    /** A switch that has the tool turned off (#1314 m6). */
    switchRefusal?: { code: string; message: string } | null } | null;
  roles?: () => ReadonlySet<string>;
  /** The enrolled computers, for the reviewed-UI step checks (#1314). */
  machines?: () => readonly WorkflowMachineView[];
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
// The engine's operator values. "Starts with" has two spellings that mean the
// same condition: the engine's value TEXT_START_WITH, which the dashboard saves,
// and its enum key TEXT_STARTS_WITH, which composed workflows write. The engine
// accepts both (router-executor.ts) and fails a step on any other unknown operator.
const OPERATORS = new Set([
  'TEXT_CONTAINS', 'TEXT_DOES_NOT_CONTAIN', 'TEXT_EXACTLY_MATCHES', 'TEXT_DOES_NOT_EXACTLY_MATCH',
  'TEXT_START_WITH', 'TEXT_STARTS_WITH', 'TEXT_ENDS_WITH', 'TEXT_DOES_NOT_START_WITH', 'TEXT_DOES_NOT_END_WITH',
  'TEXT_MATCHES_REGEX', 'TEXT_DOES_NOT_MATCH_REGEX', 'LIST_CONTAINS', 'LIST_DOES_NOT_CONTAIN',
  'NUMBER_IS_GREATER_THAN', 'NUMBER_IS_LESS_THAN', 'NUMBER_IS_EQUAL_TO', 'BOOLEAN_IS_TRUE',
  'BOOLEAN_IS_FALSE', 'DATE_IS_AFTER', 'DATE_IS_EQUAL', 'DATE_IS_BEFORE', 'LIST_IS_EMPTY',
  'LIST_IS_NOT_EMPTY', 'EXISTS', 'DOES_NOT_EXIST',
]);
// Nested DYNAMIC fields need their own resolved schemas; the engine's saved
// property settings only address top-level dynamic properties.
const ROW_SCHEMA_TYPES = new Set(['SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'CHECKBOX', 'DATE_TIME', 'COLOR', 'STATIC_DROPDOWN', 'DROPDOWN', 'STATIC_MULTI_SELECT_DROPDOWN', 'MULTI_SELECT_DROPDOWN', 'JSON', 'OBJECT', 'ARRAY', 'FILE', 'MARKDOWN']);
const UNKNOWN_INPUT = Symbol('runtime input');
export const CONNECTION_SOURCE = /^connections(?:\.([\w:-]+)|\['([^']+)'\])$/;
const UNARY = new Set(['BOOLEAN_IS_TRUE', 'BOOLEAN_IS_FALSE', 'LIST_IS_EMPTY', 'LIST_IS_NOT_EMPTY', 'EXISTS', 'DOES_NOT_EXIST']);

const DEFAULT_VALUE_STEP = { pieceName: '@activepieces/piece-text-helper', actionName: 'defaultValue' };
const COMPUTED_KEY_CHECK = 'A property name taken from run data is checked when the flow runs. Names that reach into object internals are refused then.';
const RUN_SKILL_NAME_CHECK = 'The skill name is taken from run data. Jarvis can only show you what the skill will do once the run has a name, so it is checked and reviewed then. Writing the name in the step lets you review it before the flow runs.';

/** Constant expressions are known inputs, not runtime unknowns. */
function staticInput(value: unknown): { known: boolean; value: unknown } {
  if (typeof value !== 'string' || !value.includes('{{')) return { known: true, value };
  try {
    const matches = [...value.matchAll(/\{\{(.*?)\}\}/g)];
    if (!matches.length || matches.some(m => CONNECTION_SOURCE.test(m[1]!) || workflowExpressionReferences(m[1]!).size)) return { known: false, value };
    if (matches.length === 1 && matches[0]![0] === value) return { known: true, value: evaluateWorkflowExpression(matches[0]![1]!, {}) };
    return { known: true, value: value.replace(/\{\{(.*?)\}\}/g, (_, source) => String(evaluateWorkflowExpression(source, {}))) };
  } catch { return { known: false, value }; } // syntax errors are reported by expressions()
}

/** Pure, bounded compiler shared by model output and persisted graph activation.
 * Branch outputs join their router's continuation as runtime-dependent data.
 * Siblings remain isolated, and loop-body outputs stay within their loop.
 */
export function compileWorkflow(trigger: unknown, context: ReadinessContext = {}): WorkflowReadiness {
  const issues: ReadinessIssue[] = [], runtimeChecks: RuntimeCheck[] = [], setupIssues: ReadinessIssue[] = [];
  const seen = new Set<unknown>(), names = new Set<string>();
  // Every node inside a loop body: a refund step there would propose once per iteration for one ticket.
  const refundLoopBodies = new Set<unknown>();
  for (const n of walkFlowNodes(object(trigger) ? trigger as FlowTriggerNode : null)) {
    if (n.type === 'LOOP_ON_ITEMS' && n.firstLoopAction) for (const inner of walkFlowNodes(n.firstLoopAction)) refundLoopBodies.add(inner);
  }
  // Loop steps and everything inside a loop body: data that differs from one pass to the next.
  const loopVarying = new Set<string>();
  for (const n of walkFlowNodes(object(trigger) ? trigger as FlowTriggerNode : null)) {
    if (n.type !== 'LOOP_ON_ITEMS') continue;
    loopVarying.add(String(n.name));
    if (n.firstLoopAction) for (const inner of walkFlowNodes(n.firstLoopAction)) loopVarying.add(String(inner.name));
  }
  // Steps inside a router branch, seen from a step after the router: they ran only if that branch was taken.
  const branchOnly = new Set<string>();
  /** True when a template anywhere in the value names something from the loop, so it can differ per pass.
   * A template that does not parse counts as varying: it is reported on its own. */
  const perPass = (value: unknown, depth = 0): boolean => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{(.*?)\}\}/g)) {
        try { if ([...workflowExpressionReferences(match[1]!.trim())].some(ref => loopVarying.has(ref))) return true; } catch { return true; }
      }
      return false;
    }
    if (depth > 32 || value === null || typeof value !== 'object') return false;
    return Object.values(value).some(item => perPass(item, depth + 1));
  };
  /** A non-empty key that names nothing from the loop, so every pass would use the same one. */
  const constantKey = (key: unknown): boolean => typeof key === 'string' && !!key.trim() && !perPass(key);
  let count = 0, inputVisits = 0, schemaVisits = 0, runtimeCount = 0, previewFound = false;
  const issue = (node: string, path: string, code: string, message: string, allowedPieces?: readonly string[]) => {
    if (issues.length < 100) issues.push({ node, path, code, message, ...(allowedPieces ? { allowedPieces: [...allowedPieces] } : {}) });
  };
  // The settings of the piece step whose input is being read, for connection checks.
  let stepSettings: Record<string, unknown> = {};
  const needsSetup = (node: string, path: string, message: string) => {
    if (context.phase === 'composition') {
      if (setupIssues.length < 100) setupIssues.push({ node, path, code: 'SETUP_REQUIRED', message });
    } else issue(node, path, 'SETUP_REQUIRED', message);
  };
  const runtime = (node: string, path: string, guard: RuntimeCheck['guard'], message: string) => {
    if (++runtimeCount === 501) issue(node, path, 'LIMIT', 'Graph exceeds 500 runtime checks');
    if (runtimeChecks.length < 500) runtimeChecks.push({ node, path, code: 'RUNTIME_CHECK', guard, message });
  };

  function expressions(value: unknown, node: string, path: string, scope: Set<string>, pieceName: string, depth = 0): boolean {
    if (++inputVisits > 20_000) {
      if (inputVisits === 20_001) issue(node, path, 'LIMIT', 'Inputs exceed the validation traversal budget');
      return false;
    }
    if (depth > 64) { issue(node, path, 'LIMIT', 'Input nesting exceeds 64 levels'); return false; }
    if (Array.isArray(value) || object(value)) {
      let dynamic = false;
      for (const [key, child] of Object.entries(value)) dynamic = expressions(child, node, `${path}.${key}`, scope, pieceName, depth + 1) || dynamic;
      return dynamic;
    }
    if (typeof value !== 'string' || !value.includes('{{')) return false;
    const matches = [...value.matchAll(/\{\{(.*?)\}\}/g)];
    if (!matches.length || value.replace(/\{\{(.*?)\}\}/g, '').includes('{{')) {
      issue(node, path, 'EXPRESSION', 'Unclosed or multiline template expression'); return true;
    }
    for (const match of matches) {
      const source = match[1]!.trim();
      try {
        // Connections use an opaque ID grammar in the engine and editor.
        // Parse them before expressions so my-gmail is not subtraction.
        const connection = CONNECTION_SOURCE.exec(source);
        if (connection && source === match[1]) {
          if (context.phase !== 'composition') {
            const reason = context.connection?.((connection[1] ?? connection[2])!, pieceName, path, stepSettings) ?? (context.connection ? null : 'Connection inventory is unavailable');
            if (typeof reason === 'string') issue(node, path, 'CONNECTION_BINDING', reason);
            else if (reason) issue(node, path, 'CONNECTION_BINDING', reason.message, reason.allowedPieces);
            else runtime(node, path, 'connection', 'Re-resolve this project-scoped connection before dispatch');
          }
          continue;
        }
        const refs = workflowExpressionReferences(source);
        for (const ref of refs) if (ref !== 'connections' && !scope.has(ref)) {
          issue(node, path, 'REFERENCE_SCOPE', `Reference "${ref}" is missing, later in the graph, or outside this branch/loop scope`);
        }
        // A fallback keeps it publishable: `??`, or the default-value step reading exactly one reference.
        const guarded = DEFAULT_VALUE_STEP.pieceName === pieceName && stepSettings.actionName === DEFAULT_VALUE_STEP.actionName && path === 'settings.input.value' && value === match[0]
          ? refs : workflowExpressionGuardedReferences(source);
        for (const ref of refs) if (scope.has(ref) && branchOnly.has(ref) && !guarded.has(ref)) {
          // A notice, not a refusal: a published workflow that always takes this branch works today,
          // and readiness is checked again whenever a trigger fires.
          runtime(node, path, 'expression', `"${ref}" is inside a branch that does not run every time, so it has no value on runs that take another branch. Move this step into the branch, or give the reference a fallback such as {{${ref} ?? 'none'}}`);
        }
        if (refs.has('connections')) issue(node, path, 'CONNECTION_BINDING', "Use a complete {{connections.id}} or {{connections['id']}} binding");
        else if (refs.size) runtime(node, path, 'expression', 'Resolve data at runtime; an absent value must fail before dispatch (use an explicit fallback for optional data)');
        else evaluateWorkflowExpression(source, {}); // Catch invalid literal computations too.
        if (workflowExpressionHasComputedKey(source)) runtime(node, path, 'expression', COMPUTED_KEY_CHECK);
      } catch (error) { issue(node, path, 'EXPRESSION', (error as Error).message); }
    }
    return true;
  }

  // A saved dynamic schema is an engine input contract. Check known data
  // now; for runtime data validate the schema and leave value checks to the
  // same schema in propsProcessor. Bound schemas and array rows like graphs.
  function propertyObject(schema: unknown, value: unknown, node: string, path: string, depth = 0): void {
    if (++schemaVisits > 20_000 || depth > 64) {
      issue(node, path, 'LIMIT', 'Property schema validation exceeds its traversal budget'); return;
    }
    if (!object(schema)) { issue(node, path, 'UNRESOLVED_CHECK', 'Expected a resolved property schema'); return; }
    const resolved = value === UNKNOWN_INPUT ? { known: false, value } : staticInput(value);
    if (resolved.known && !object(resolved.value)) {
      issue(node, path, 'INPUT_TYPE', 'Expected a property object');
    }
    for (const [name, prop] of Object.entries(schema)) {
      if (++schemaVisits > 20_000) { issue(node, path, 'LIMIT', 'Property schema validation exceeds its traversal budget'); return; }
      const childPath = `${path}.${name}`;
      if (!object(prop) || !ROW_SCHEMA_TYPES.has(prop.type) || (prop.required !== undefined && typeof prop.required !== 'boolean')) {
        issue(node, childPath, 'UNRESOLVED_CHECK', 'Unsupported or unresolved property schema'); continue;
      }
      const field = propsToInputSchema({ [name]: prop }).fields[0];
      if (!field) continue; // Display-only markdown.
      const input = resolved.known && object(resolved.value) ? staticInput(resolved.value[name]) : { known: false, value: UNKNOWN_INPUT };
      if (input.known) {
        const reason = inputIssue(field, input.value);
        if (reason) issue(node, childPath, 'INPUT_TYPE', reason);
      }
      if (prop.type === 'ARRAY' && prop.properties !== undefined) {
        arrayProperties(prop.properties, input.known ? input.value : UNKNOWN_INPUT, node, childPath, depth + 1);
      }
    }
  }

  /** The same row validation for declared ARRAY properties and dynamic schemas. */
  function arrayProperties(schema: unknown, value: unknown, node: string, path: string, depth = 0): void {
    const input = value === UNKNOWN_INPUT ? { known: false, value } : staticInput(value);
    let rows: unknown[] = [];
    if (input.known && Array.isArray(input.value)) rows = input.value;
    else if (input.known && object(input.value)) {
      // Mirror arrayZipperProcessor's column map without executing expressions.
      const columns = Object.entries(input.value);
      const length = columns.reduce((n, [, v]) => Math.max(n, Array.isArray(v) ? v.length : 1), 0);
      if (length * Math.max(1, columns.length) > 20_000 - schemaVisits) {
        issue(node, path, 'LIMIT', 'Property rows exceed the validation budget'); return;
      }
      rows = Array.from({ length }, (_, i) => Object.fromEntries(columns.map(([key, v]) => [key, Array.isArray(v) ? v[i] : v])));
    }
    // Empty and runtime-dependent collections still need a supported schema,
    // but their absent rows must not fabricate missing required cell errors.
    if (!rows.length) propertyObject(schema, UNKNOWN_INPUT, node, `${path}[]`, depth + 1);
    else for (let i = 0; i < rows.length && schemaVisits <= 20_000; i++) propertyObject(schema, rows[i], node, `${path}.${i}`, depth + 1);
  }

  function visit(raw: unknown, scope: Set<string>, root: boolean, depth = 0): Set<string> {
    if (!object(raw)) { issue('?', 'graph', 'GRAPH', 'Expected a node object'); return scope; }
    const node = typeof raw.name === 'string' ? raw.name : '?';
    if (++count > 100 || depth > 64 || seen.has(raw)) {
      issue(node, 'graph', 'LIMIT', 'Graph is cyclic, reuses a node, or exceeds 100 nodes / 64 nested scopes'); return scope;
    }
    seen.add(raw);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node) || ['connections', '__proto__', 'prototype', 'constructor'].includes(node)) issue(node, 'name', 'NAME', 'Expected a unique, non-reserved identifier');
    if (names.has(node)) issue(node, 'name', 'NAME', 'Duplicate node name');
    names.add(node);
    const type = raw.type;
    const continuation = new Set([...scope, node]);
    if (!(root ? ['EMPTY', 'PIECE_TRIGGER'] : ['PIECE', 'CODE', 'LOOP_ON_ITEMS', 'ROUTER']).includes(type)) {
      issue(node, 'type', 'NODE_TYPE', `Unsupported ${root ? 'trigger' : 'action'} type`);
    }
    if (context.preview && node !== context.preview.stepName) {
      // Walk only to establish identity and lexical scope. These nodes are
      // not executed by a single-step preview and may still be unfinished.
      if (type === 'LOOP_ON_ITEMS' && raw.firstLoopAction != null) visit(raw.firstLoopAction, new Set([...scope, node]), false, depth + 1);
      if (type === 'ROUTER' && Array.isArray(raw.children)) for (const child of raw.children) {
        if (child != null) for (const name of visit(child, new Set(scope), false, depth + 1)) { continuation.add(name); if (!scope.has(name)) branchOnly.add(name); }
      }
      return raw.nextAction != null ? visit(raw.nextAction, continuation, false, depth) : continuation;
    }
    if (context.preview) previewFound = true;
    let settings = raw.settings === undefined ? {} : raw.settings;
    if (!object(settings)) { issue(node, 'settings', 'GRAPH', 'Expected settings object'); return continuation; }
    if (context.preview?.inputOverride) settings = { ...settings, input: context.preview.inputOverride };
    const input = settings.input === undefined ? {} : settings.input;
    if (!object(input)) issue(node, 'settings.input', 'INPUT_TYPE', 'Expected an input object');
    const pieceName = typeof settings.pieceName === 'string' ? settings.pieceName : '';
    // Any auth that names the managed account, not only the two exact spellings:
    // a binding with text around it must not skip the action allowlist.
    if (pieceName === '@activepieces/piece-mailchimp' && object(input)
      && typeof input.auth === 'string' && input.auth.includes('jarvis:mailchimp')) {
      const reason = managedMailchimpIssue(root ? settings.triggerName : settings.actionName, input, false);
      if (reason) issue(node, 'settings.input', 'MANAGED_MAILCHIMP', reason);
    }
    if (pieceName === '@activepieces/piece-github' && object(input)
      && ["{{connections.jarvis:github}}", "{{connections['jarvis:github']}}"].includes(String(input.auth))) {
      const reason = managedGitHubIssue(root ? settings.triggerName : settings.actionName, input, false);
      if (reason) issue(node, 'settings.input', 'MANAGED_GITHUB', reason);
    }
    if (pieceName === '@activepieces/piece-airtable' && object(input)
      && ["{{connections.jarvis:airtable}}", "{{connections['jarvis:airtable']}}"].includes(String(input.auth))) {
      const reason = managedAirtableIssue(root ? settings.triggerName : settings.actionName, input, false);
      if (reason) issue(node, 'settings.input', 'MANAGED_AIRTABLE', reason);
    }
    if (pieceName === '@activepieces/piece-notion' && object(input)
      && ["{{connections.jarvis:notion}}", "{{connections['jarvis:notion']}}"].includes(String(input.auth))) {
      const reason = managedNotionIssue(root ? settings.triggerName : settings.actionName, input, false);
      if (reason) issue(node, 'settings.input', 'MANAGED_NOTION', reason);
    }
    if (pieceName === '@activepieces/piece-trello' && object(input)
      && ["{{connections.jarvis:trello}}", "{{connections['jarvis:trello']}}"].includes(String(input.auth))) {
      const reason = managedTrelloIssue(root ? settings.triggerName : settings.actionName, input, false);
      if (reason) issue(node, 'settings.input', 'MANAGED_TRELLO', reason);
    }
    if (pieceName === '@activepieces/piece-slack' && object(input)
      && ["{{connections.jarvis:slack}}", "{{connections['jarvis:slack']}}"].includes(String(input.auth))) {
      const reason = managedSlackIssue(root ? settings.triggerName : settings.actionName, input, false);
      if (reason) issue(node, 'settings.input', 'MANAGED_SLACK', reason);
    }
    // Only input values are templated; source code and labels are not expressions.
    // A connection is checked against the step's piece, and only a piece step
    // has one: a CODE step's `settings.pieceName` is ignored by the engine, so
    // it must not lend the step a piece's connections either.
    stepSettings = settings;
    expressions(input, node, 'settings.input', scope, type === 'PIECE' || type === 'PIECE_TRIGGER' ? pieceName : '');
    stepSettings = {};
    const isPiece = (short: string) => pieceName === short || pieceName === `@jarvispieces/piece-${short}`;
    if (!root && isRefundAction(settings) && pieceName !== REFUND_PIECE) issue(node, 'settings.pieceName', 'PIECE', `Use the full piece name ${REFUND_PIECE}`);
    if (!root && isRefundAction(settings) && refundLoopBodies.has(raw)) issue(node, 'type', 'GRAPH', REFUND_LOOP_REFUSAL);
    if (!root && isRefundAction(settings) && object(input)) {
      for (const [field, provider] of Object.entries(REFUND_ACCOUNTS)) {
        const id = input[field];
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node,`settings.input.${field}`,'CONNECTION_BINDING','Select a saved Stripe account');
          // No managed-connection exemption covers the refund; the refund backend refuses a jarvis: id at run time too.
          else if (id.startsWith('jarvis:')) issue(node, `settings.input.${field}`, 'CONNECTION_BINDING', managedRefundRefusal(field as RefundAccountField));
          else if (context.phase !== 'composition') {
            const refusal=context.connection?.(id,provider,`settings.input.${field}`,settings,type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
          }
        }
      }
      // The event supplies only the ticket; the runtime refuses any setup field that differs from the saved literal.
      for (const k of [...REFUND_REQUIRED.filter(k=>k!=='ticket'),'amountMinorPath']) if (typeof input[k] === 'string' && input[k].includes('{{')) issue(node,`settings.input.${k}`,'INPUT_TYPE','Refund setup fields are fixed values; only the ticket maps the event');
      if(REFUND_REQUIRED.filter(k=>k!=='ticket').every(k=>!emptyInput(input[k]))) try {refundSetup(input);} catch(e){issue(node,'settings.input','INPUT_TYPE',(e as Error).message);}
      runtime(node,'settings.input','connection','Recheck pinned Stripe account and mode; exact amount approval expires after 48 hours. Refund dispatch requires durable approval and fresh payment state.');
    }
    if (!root && isImportStep(settings) && pieceName !== IMPORT_PIECE) issue(node, 'settings.pieceName', 'PIECE', `Use the full piece name ${IMPORT_PIECE}`);
    if (!root && isImportStep(settings) && object(input)) {
      for (const field of importAccountFields(input)) {
        const provider = IMPORT_ACCOUNTS[field], id = input[field];
        if (field === 'sourceConnection' && emptyInput(id)) needsSetup(node,`settings.input.${field}`,'Select the source OAuth2 account');
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node,`settings.input.${field}`,'CONNECTION_BINDING','Select a saved account reference');
          // No managed-connection exemption covers the import; the import backend refuses a jarvis: id at run time too.
          else if (id.startsWith('jarvis:')) issue(node, `settings.input.${field}`, 'CONNECTION_BINDING', managedImportRefusal(field));
          else if (context.phase !== 'composition') {
            const refusal=context.connection?.(id,provider,`settings.input.${field}`,settings,type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
            else runtime(node,`settings.input.${field}`,'connection','Recheck pinned import account before each operation');
          }
        }
      }
      if (IMPORT_REQUIRED.every(k=>!emptyInput(input[k])) && (input.sourceAuth !== 'oauth2' || !emptyInput(input.sourceConnection))) try { importSetup(input); } catch (e) { issue(node,'settings.input','INPUT_TYPE',(e as Error).message); }
    }
    const quarterly = isQuarterlyReportStep(settings);
    if (!root && (isReportStep(settings) || quarterly) && pieceName !== REPORT_PIECE) issue(node, 'settings.pieceName', 'PIECE', `Use the full piece name ${REPORT_PIECE}`);
    if (!root && (isReportStep(settings) || quarterly) && object(input)) {
      for (const [field, provider] of Object.entries(quarterly ? QUARTERLY_ACCOUNTS : REPORT_ACCOUNTS)) {
        const id = input[field];
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node,`settings.input.${field}`,'CONNECTION_BINDING','Select a saved account reference');
          // No managed-connection exemption covers either report; the report backends refuse a jarvis: id at run time too.
          else if (id.startsWith('jarvis:')) issue(node, `settings.input.${field}`, 'CONNECTION_BINDING', quarterly ? QUARTERLY_MANAGED_REFUSAL : managedReportRefusal(field as ReportAccountField));
          else if (context.phase !== 'composition') {
            const refusal=context.connection?.(id,provider,`settings.input.${field}`,settings,type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
            else runtime(node,`settings.input.${field}`,'connection','Recheck pinned report account before each provider call');
          }
        }
      }
      if (quarterly && (!object(trigger) || trigger.settings?.pieceName !== 'schedule' || input.scheduledFor !== `{{${trigger.name}.scheduledFor}}`)) issue(node,'settings.input.scheduledFor','INPUT_TYPE','Map the persisted schedule trigger scheduledFor; execution-time dates are not supported');
      // Quarters are Rome calendar quarters: a schedule firing in another zone (its chosen one, else Jarvis's) could start on another Rome date.
      if (quarterly && object(trigger) && trigger.settings?.pieceName === 'schedule' && canonicalZone(effectiveScheduleZone(trigger.settings)) !== QUARTERLY_ZONE) issue(String(trigger.name),'settings.input.timezone','INPUT_TYPE',`Quarterly reporting uses ${QUARTERLY_ZONE} calendar quarters; choose ${QUARTERLY_ZONE} as the schedule time zone`);
      if ((quarterly ? QUARTERLY_REQUIRED : REPORT_REQUIRED).every(k=>!emptyInput(input[k]))) try { (quarterly ? quarterlySetup : reportSetup)(input); } catch (e) { issue(node,'settings.input','INPUT_TYPE',(e as Error).message); }
    }
    if (!root && isPiece('jarvis-subflow') && settings.actionName === 'call' && object(input)) {
      if (!emptyInput(input.outputSchema)) try {parseOutputSchema(input.outputSchema);} catch(e) {issue(node,'settings.input.outputSchema','INPUT_TYPE',(e as Error).message);}
      if (!emptyInput(input.timeoutSeconds) && (!Number.isInteger(input.timeoutSeconds)||Number(input.timeoutSeconds)<1||Number(input.timeoutSeconds)>86400)) issue(node,'settings.input.timeoutSeconds','INPUT_TYPE','Child timeout must be 1-86400 seconds');
      // Only when the payload differs per pass: a constant key with a constant payload is one
      // deduplicated call, which published workflows may rely on (readiness runs at every trigger).
      if (refundLoopBodies.has(raw) && constantKey(input.invocationKey) && perPass(input.payload)) {
        issue(node, 'settings.input.invocationKey', 'INPUT_TYPE', 'The invocation key is the same on every pass of the loop, so the second pass is refused. Include something that changes per item, such as {{loop.item.id}} or {{loop.index}}');
      }
      runtime(node,'settings.input.invocationKey','piece-input','Persist child invocation and validated output across parent retries; refuse changed payload/configuration under the same key');
      runtime(node,'settings.input.flow','workflow-binding','Pin child version, apply Authority, validate returned JSON, preserve absolute deadline and expose failure/timeout explicitly');
    }
    if (!root && isBatchStep(settings) && pieceName !== BATCH_PIECE) issue(node, 'settings.pieceName', 'PIECE', `Use the full piece name ${BATCH_PIECE}`);
    if (!root && isBatchStep(settings) && object(input)) {
      const graphError=batchGraphError(raw); if(graphError) issue(node,'nextAction','INPUT_TYPE',graphError);
      if (object(trigger) && trigger.settings?.pieceName === 'webhook' && Object.values(trigger.settings.input ?? {}).some(v=>!emptyInput(v))) issue(node,'trigger.settings.input','INPUT_TYPE','Lead batch owns submission admission; do not add webhook admission that prevents incomplete batch resumption');
      for (const [field, provider] of Object.entries(BATCH_ACCOUNTS)) {
        const id = input[field];
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node,`settings.input.${field}`,'CONNECTION_BINDING','Select a saved account reference');
          else if (context.phase !== 'composition') {
            // Checked against the provider piece this field reads with, at its own path:
            // managedConnectionMisuse refuses a managed connection here (no exemption covers lead batches).
            const refusal=context.connection?.(id,provider,`settings.input.${field}`,settings,type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
            else runtime(node,`settings.input.${field}`,'connection','Recheck pinned batch account before each provider call');
          }
        }
      }
      if (BATCH_REQUIRED.every(k=>!emptyInput(input[k]))) try { batchSetup(input); } catch (e) { issue(node,'settings.input','INPUT_TYPE',(e as Error).message); }
    }
    if (!root && isOnboardingStep(settings) && pieceName !== ONBOARDING_PIECE) issue(node, 'settings.pieceName', 'PIECE', `Use the full piece name ${ONBOARDING_PIECE}`);
    if (!root && isOnboardingStep(settings) && object(input)) {
      for (const [field, provider] of Object.entries(ONBOARDING_ACCOUNTS)) {
        const id = input[field];
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node,`settings.input.${field}`,'CONNECTION_BINDING','Select a saved account reference');
          else if (context.phase !== 'composition') {
            // Checked against the provider piece this field reads with, at its own path:
            // managedConnectionMisuse refuses a managed connection here (no exemption covers onboarding).
            const refusal=context.connection?.(id,provider,`settings.input.${field}`,settings,type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
            else runtime(node,`settings.input.${field}`,'connection','Recheck pinned onboarding account before each provider call');
          }
        }
      }
      if (ONBOARDING_REQUIRED.every(k=>!emptyInput(input[k]))) try { onboardingSetup(input); } catch (e) { issue(node,'settings.input','INPUT_TYPE',(e as Error).message); }
    }
    if (!root && isSalesStep(settings) && pieceName !== SALES_PIECE) issue(node, 'settings.pieceName', 'PIECE', `Use the full piece name ${SALES_PIECE}`);
    if (!root && isSalesStep(settings) && object(input)) {
      for (const [field, provider] of Object.entries(SALES_ACCOUNTS)) {
        const id = input[field];
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node,`settings.input.${field}`,'CONNECTION_BINDING','Select a saved account reference');
          // Jarvis manages no HubSpot account; the sales backend refuses a jarvis: id here at run time.
          else if (field === 'hubspotConnection' && id.startsWith('jarvis:')) issue(node, `settings.input.${field}`, 'CONNECTION_BINDING', MANAGED_HUBSPOT_REFUSAL);
          else if (context.phase !== 'composition') {
            // Checked against the provider piece this field reads with, at its own
            // path: a managed connection is accepted here only by the narrow
            // sales exemption in managedConnectionMisuse (jarvis:google as Gmail).
            const refusal=context.connection?.(id,provider,`settings.input.${field}`,settings,type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
            else runtime(node,`settings.input.${field}`,'connection','Recheck pinned sales account before each provider call');
          }
        }
      }
      if (SALES_REQUIRED.every(k=>!emptyInput(input[k]))) try { salesSetup(input); } catch (e) { issue(node,'settings.input','INPUT_TYPE',(e as Error).message); }
    }
    if (!root && isPiece('jarvis-context') && settings.actionName === 'meeting_briefs' && object(input)) {
      for (const [field, provider] of Object.entries(MEETING_ACCOUNTS)) {
        const id = input[field];
        if (!emptyInput(id)) {
          if (typeof id !== 'string' || !/^[\w:-]+$/.test(id)) issue(node, `settings.input.${field}`, 'CONNECTION_BINDING', 'Select a saved account reference');
          // Jarvis manages no HubSpot account; the meeting backend refuses a jarvis: id here at run time.
          else if (field === 'hubspotConnection' && id.startsWith('jarvis:')) issue(node, `settings.input.${field}`, 'CONNECTION_BINDING', MANAGED_HUBSPOT_REFUSAL);
          else if (context.phase !== 'composition') {
            // Checked against the provider piece this field reads with, at its own
            // path: a managed connection is accepted here only by the narrow
            // meeting exemption in managedConnectionMisuse.
            const refusal = context.connection?.(id, provider, `settings.input.${field}`, settings, type) ?? (context.connection ? null : 'Connection inventory unavailable');
            const reason = typeof refusal === 'string' || refusal === null ? refusal : refusal.message;
            if (reason) issue(node,`settings.input.${field}`,'CONNECTION_BINDING',reason);
            else runtime(node,`settings.input.${field}`,'connection','Recheck the pinned provider account before every read');
          }
        }
      }
      const complete = ['calendarConnection','gmailConnection','hubspotConnection','calendarId','ownerEmail','internalDomains','hubspotPortalId'].every(k=>!emptyInput(input[k]));
      if (complete) try { meetingSetup(input); } catch (e) { issue(node,'settings.input','INPUT_TYPE',(e as Error).message); }
    }
    if (!root && isPiece('jarvis-ask') && settings.actionName === 'ask' && !emptyInput(input?.outputSchema)) {
      const declared = staticInput(input.outputSchema);
      if (!declared.known) runtime(node, 'settings.input.outputSchema', 'piece-input', 'Validate the resolved output schema before model dispatch');
      else {
        try { parseOutputSchema(typeof declared.value === 'string' ? JSON.parse(declared.value) : declared.value); }
        catch (error) { issue(node, 'settings.input.outputSchema', 'OUTPUT_SCHEMA', (error as Error).message); }
      }
    }
    if (!root && isPiece('jarvis-tool') && settings.actionName === 'invoke' && object(input)) {
      const refusal = typeof input.toolName === 'string' ? workflowToolRefusal(input.toolName) : null;
      if (refusal) issue(node, 'settings.input.toolName', 'WORKFLOW_TOOL_UNSUPPORTED', refusal);
      if (typeof input.toolName === 'string') {
        let machines: readonly WorkflowMachineView[] | undefined;
        try { machines = context.machines?.(); } catch { machines = undefined; }
        for (const found of workflowUiStepRefusals(input.toolName, input.params, machines)) {
          issue(node, found.path, found.code ?? 'WORKFLOW_TOOL_UNSUPPORTED', found.message);
        }
      }
    }
    if (!root && isPiece('jarvis-tool') && settings.actionName === 'invoke' && object(input) && context.phase !== 'composition') {
      const name = { value: input.toolName };
      // Named in the workflow, never by a template: run data choosing the tool
      // is refused at dispatch as well (effect-context.ts, #1152).
      if (typeof input.toolName === 'string' && input.toolName.includes('{{')) issue(node, 'settings.input.toolName', 'TOOL_BINDING', 'Name the tool directly; a template would let run data choose which tool runs');
      else if (typeof name.value !== 'string') issue(node, 'settings.input.toolName', 'TOOL_BINDING', 'Tool identity must resolve to a string');
      else {
        const tool = context.tool?.(name.value);
        if (!tool) issue(node, 'settings.input.toolName', 'TOOL_BINDING', context.tool ? 'Unknown tool' : 'Tool inventory is unavailable');
        else {
          if (tool.workflowRefusal) issue(node, 'settings.input.toolName', 'WORKFLOW_TOOL_UNSUPPORTED', tool.workflowRefusal);
          if (tool.switchRefusal) issue(node, 'settings.input.toolName', tool.switchRefusal.code, tool.switchRefusal.message);
          let params = staticInput(input.params ?? {});
          if (params.known && typeof params.value === 'string') {
            try { params = { known: true, value: JSON.parse(params.value) }; } catch { /* report below */ }
          }
          if (!params.known) runtime(node, 'settings.input.params', 'tool-input', 'Tool registry validates resolved required parameters and types before execution');
          else if (!object(params.value)) issue(node, 'settings.input.params', 'INPUT_TYPE', 'Tool params must resolve to an object');
          else for (const field of tool.params) {
            const resolved = staticInput(params.value[field.name]);
            const path = `settings.input.params.${field.name}`;
            if (!resolved.known) { runtime(node, path, 'tool-input', input.toolName === 'run_skill' && field.name === 'name' ? RUN_SKILL_NAME_CHECK : 'Tool registry validates this parameter before execution'); continue; }
            const value = resolved.value;
            if (value == null) { if (field.required) issue(node, path, 'INPUT_TYPE', 'Required tool parameter is missing'); continue; }
            const type = field.type.toLowerCase();
            if (type === 'array' ? !Array.isArray(value) : type === 'object' ? !object(value) : typeof value !== type) issue(node, path, 'INPUT_TYPE', `Tool parameter must be ${type}`);
            if (field.enum && typeof value === 'string' && !field.enum.some(v => v.toLowerCase() === value.toLowerCase())) issue(node, path, 'INPUT_TYPE', 'Tool parameter is not a declared choice');
          }
        }
      }
    }
    if (!root && isPiece('jarvis-agent') && settings.actionName === 'delegate' && !emptyInput(input?.role) && context.phase !== 'composition') {
      const role = staticInput(input.role);
      if (!role.known || typeof role.value !== 'string' || !context.roles?.().has(role.value)) issue(node, 'settings.input.role', 'ROLE_BINDING', 'Select an existing specialist role before activation');
    }
    if (root && pieceName === '@activepieces/piece-schedule' && settings.triggerName === 'cron_expression') {
      if (emptyInput(input?.cronExpression)) needsSetup(node,'settings.input.cronExpression','Choose the schedule execution time before publishing or running');
      else try {
        if (typeof input?.cronExpression !== 'string') throw new Error('Schedule requires a static cron expression');
        validateCronExpression(input.cronExpression);
        validateCronTimezone(input.timezone);
      } catch (error) { issue(node, 'settings.input.cronExpression', 'CRON', (error as Error).message); }
    }
    // Explicit null keeps an intentionally deferred scope visible. Omission still
    // means the connector's documented default (all labels / root folder).
    if (input?.label === null && root && pieceName === '@activepieces/piece-gmail' && settings.triggerName === 'new_attachment')
      needsSetup(node, 'settings.input.label', 'Select the Gmail label before processing attachments');
    if (pieceName === '@activepieces/piece-hubspot' && settings.actionName === 'create-or-update-contact' && input?.objectProperties === null)
      needsSetup(node, 'settings.input.objectProperties', 'Select HubSpot contact property mappings, including the intended qualification/review field');
    if (pieceName === '@activepieces/piece-google-drive') {
      const folder = settings.actionName === 'upload_gdrive_file' ? 'parentFolder' : settings.actionName === 'drive_upload_file' ? 'parent_folder_id' : null;
      if (folder && input?.[folder] === null) needsSetup(node, `settings.input.${folder}`, 'Select the destination Drive folder');
    }
    if (type === 'PIECE' || type === 'PIECE_TRIGGER') {
      if (root && pieceName === 'schedule') {
        try { validateCronDstPolicy(input?.dst_policy); }
        catch (error) { issue(node, 'settings.input.dst_policy', 'DST_POLICY', (error as Error).message); }
        const cron = input?.cron_expression || input?.cronExpression || input?.expression;
        if (emptyInput(cron)) needsSetup(node,'settings.input.cron_expression','Choose the schedule execution time before publishing or running');
        else try {
          if (typeof cron !== 'string') throw new Error('Schedule requires a static cron expression');
          validateCronExpression(cron);
        } catch (error) { issue(node, 'settings.input.cron_expression', 'CRON', (error as Error).message); }
        // An empty zone means Jarvis's. A zone nobody chose is not used (the
        // trigger list warns), so a saved schedule is not refused for one;
        // a chosen zone, or any zone a composition writes, must be real.
        const stated = statedScheduleZone(settings);
        if (stated !== undefined && (context.phase === 'composition' || chosenScheduleZone(settings) !== undefined)) {
          try { validateCronTimezone(stated); }
          catch (error) { issue(node, 'settings.input.timezone', 'TIMEZONE', (error as Error).message); }
        }
      } else if (root && pieceName === 'webhook') {
        if (object(input) && ('submission_id_field' in input || 'submission_email_field' in input)) {
          for (const [key, label] of [['submission_id_field', 'Submission ID field'], ['submission_email_field', 'Email field']]) {
            if (emptyInput(input[key!])) needsSetup(node, `settings.input.${key}`, `${label}: choose the field path in your form payload`);
          }
        }
        if (object(input) && 'request_id_field' in input && emptyInput(input.request_id_field)) needsSetup(node, 'settings.input.request_id_field', 'Request ID field: choose the stable ID path in your webhook payload');
        try { submissionConfig(input, true); }
        catch (error) { issue(node, 'settings.input.submission', 'INPUT', (error as Error).message); }
      } else {
        const piece = context.pieces?.get(pieceName);
        if (!piece) issue(node, 'settings.pieceName', 'PIECE', context.pieces ? `Unknown piece "${pieceName}"` : 'Piece catalog is unavailable; readiness cannot be verified');
        else {
          const key = root ? 'triggerName' : 'actionName';
          const entries = root ? piece.triggers : piece.actions;
          const sub: PieceCatalogAction | undefined = entries && typeof settings[key] === 'string' && Object.hasOwn(entries, settings[key]) ? entries[settings[key]] : undefined;
          if (!sub) issue(node, `settings.${key}`, 'ACTION', `Unknown ${key} for ${pieceName}`);
          else if (object(input)) {
            const schema = root ? sub.inputSchema
              : isPipedriveReference(pieceName, input.auth) ? pipedriveInputSchema(settings.actionName) ?? sub.inputSchema
              : isWrikeReference(pieceName, input.auth) ? wrikeInputSchema(settings.actionName) ?? sub.inputSchema
              : isZoomReference(pieceName, input.auth) ? zoomInputSchema(settings.actionName) ?? sub.inputSchema
              : isHelpScoutReference(pieceName, input.auth) ? helpScoutInputSchema(settings.actionName) ?? sub.inputSchema
              : isGitLabReference(pieceName, input.auth) ? gitlabInputSchema(settings.actionName) ?? sub.inputSchema
              : isWebflowReference(pieceName, input.auth) ? webflowInputSchema(settings.actionName) ?? sub.inputSchema
              : isMondayReference(pieceName, input.auth) ? mondayInputSchema(settings.actionName) ?? sub.inputSchema
              : sub.inputSchema;
            if (!root && isHelpScoutReference(pieceName, input.auth) && settings.actionName === 'find_conversation') {
              if (emptyInput(input.conversationId)) {
                if (emptyInput(input.mailboxId)) needsSetup(node, 'settings.input.mailboxId', 'Choose a Conversation ID, or both Inbox ID and Conversation number');
                if (emptyInput(input.number)) needsSetup(node, 'settings.input.number', 'Choose a Conversation ID, or both Inbox ID and Conversation number');
              } else if (!emptyInput(input.mailboxId) || !emptyInput(input.number)) {
                issue(node, 'settings.input.conversationId', 'INPUT', 'Choose a Conversation ID, or an inbox and number, not both');
              }
            }
            for (const field of schema?.fields ?? []) {
              const value = input[field.name];
              const path = `settings.input.${field.name}`;
              if (field.required && emptyInput(value)) {
                needsSetup(node, path, `${field.label || field.name}: fill in this required input`);
                continue;
              }
              if (field.sourceType === 'DYNAMIC' && (field.required || !emptyInput(value))) {
                propertyObject(settings.propertySettings?.[field.name]?.schema, value, node, path);
              }
              if (field.sourceType === 'ARRAY' && field.arrayHasProperties && (field.required || !emptyInput(value))) {
                arrayProperties(field.arrayProperties, value, node, path);
              }
              if (field.type === 'json' && !emptyInput(value)) runtime(node, path, 'piece-input', 'Validate the actual piece property schema after input resolution');
              const resolved = staticInput(value);
              const dynamic = !resolved.known;
              if (context.phase === 'composition' && field.type === 'flow_ref' && emptyInput(value)) continue;
              if (dynamic) {
                runtime(node, path, field.type === 'flow_ref' ? 'workflow-binding' : 'piece-input', `Check ${field.required ? 'required ' : ''}${field.type} input before dispatch`);
                // Workflow identity must be fixed at activation. The current
                // run_workflow action accepts display names too, so a computed
                // identity cannot promise a particular workflow/approval scope.
                if (field.type === 'flow_ref') issue(node, path, 'WORKFLOW_BINDING', 'Select a stable workflow ID before activation');
              } else {
                const reason = inputIssue(field, resolved.value);
                if (reason) issue(node, path, 'INPUT_TYPE', reason);
                if (field.type === 'flow_ref' && !emptyInput(resolved.value) && context.phase !== 'composition') {
                  const reason = context.workflow?.(String(resolved.value)) ?? (context.workflow ? null : 'Workflow inventory is unavailable');
                  if (reason) issue(node, path, 'WORKFLOW_BINDING', reason);
                  else runtime(node, path, 'workflow-binding', 'Recheck the target version and run binding before starting the nested workflow');
                }
              }
            }
            if (piece.auth && sub.requireAuth !== false) {
              if (typeof input.auth !== 'string' || !/^\{\{connections(?:\.[\w:-]+|\['[^']+'\])\}\}$/.test(input.auth)) {
                if (context.phase === 'composition') needsSetup(node, 'settings.input.auth', 'Select a saved connection for this authenticated action');
                else issue(node, 'settings.input.auth', 'CONNECTION_BINDING', 'Select a saved connection for this authenticated action');
              }
            }
          }
        }
      }
    }
    if (type === 'CODE' && (!object(settings.sourceCode) || typeof settings.sourceCode.code !== 'string' || typeof settings.sourceCode.packageJson !== 'string')) {
      issue(node, 'settings.sourceCode', 'CODE', 'CODE requires a source bundle');
    } else if (type === 'CODE') {
      // The same rule the run applies (#837), reported when the flow is saved
      // instead of failing every run of it.
      try {
        declaredDependencies(node, settings.sourceCode.packageJson);
      } catch (e) {
        issue(node, 'settings.sourceCode.packageJson', 'CODE', (e as Error).message);
      }
    }
    if (type === 'LOOP_ON_ITEMS') {
      const dynamic = expressions(settings.items, node, 'settings.items', scope, '');
      if (typeof settings.items !== 'string' || !/^\{\{.*\}\}$/.test(settings.items)) issue(node, 'settings.items', 'LOOP', 'Loop items must be an expression yielding a list');
      else if (dynamic) runtime(node, 'settings.items', 'loop-items', 'Require an array before entering the loop body');
      const items = staticInput(settings.items);
      if (items.known && !Array.isArray(items.value)) issue(node, 'settings.items', 'LOOP', 'Known loop input must be an array');
      if (raw.firstLoopAction != null) visit(raw.firstLoopAction, new Set([...scope, node]), false, depth + 1);
    } else if (raw.firstLoopAction != null) issue(node, 'firstLoopAction', 'GRAPH', 'Only LOOP_ON_ITEMS may have a loop body');
    if (type === 'ROUTER') {
      const branches = settings.branches;
      if (!['EXECUTE_FIRST_MATCH', 'EXECUTE_ALL_MATCH'].includes(settings.executionType)) issue(node, 'settings.executionType', 'ROUTER', 'Choose a supported router execution type');
      if (!Array.isArray(branches) || !branches.length || !Array.isArray(raw.children) || branches.length !== raw.children.length) {
        issue(node, 'children', 'ROUTER', 'Branch definitions and children must have the same nonzero length');
      } else {
        branches.forEach((branch, i) => {
          const path = `settings.branches.${i}`;
          if (!object(branch) || !['FALLBACK', 'CONDITION'].includes(branch.branchType)) issue(node, path, 'ROUTER', 'Expected CONDITION or FALLBACK');
          else if (branch.branchType === 'CONDITION') {
            if (!Array.isArray(branch.conditions) || !branch.conditions.length) issue(node, path, 'ROUTER', 'Conditions must be nonempty OR groups of AND conditions');
            else for (const group of branch.conditions) {
              if (!Array.isArray(group) || !group.length) { issue(node, path, 'ROUTER', 'Expected a nonempty AND group'); continue; }
              for (const condition of group) {
                if (!object(condition) || !OPERATORS.has(condition.operator) || condition.firstValue === undefined || (!UNARY.has(condition.operator) && condition.secondValue === undefined)) {
                  issue(node, path, 'ROUTER', 'Invalid operator or missing condition operand'); continue;
                }
                expressions(condition.firstValue, node, `${path}.firstValue`, scope, '');
                const dynamic = expressions(condition.secondValue, node, `${path}.secondValue`, scope, '');
                if (condition.operator.endsWith('_REGEX') && !dynamic) {
                  try { new RegExp(condition.secondValue); } catch { issue(node, path, 'REGEX', 'Invalid JavaScript regular expression'); }
                }
              }
            }
          }
          if (raw.children[i] != null) for (const name of visit(raw.children[i], new Set(scope), false, depth + 1)) { continuation.add(name); if (!scope.has(name)) branchOnly.add(name); }
        });
      }
    } else if (raw.children !== undefined) issue(node, 'children', 'GRAPH', 'Only ROUTER may have branch children');
    return raw.nextAction != null ? visit(raw.nextAction, continuation, false, depth) : continuation;
  }
  visit(trigger, new Set(), true);
  if (context.preview && !previewFound) issue(context.preview.stepName, 'graph', 'PREVIEW_STEP', 'The selected preview step does not exist');
  return { ready: issues.length === 0, issues, runtimeChecks, ...(setupIssues.length ? { setupIssues } : {}) };
}
