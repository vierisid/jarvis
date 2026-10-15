import { validateCronExpression } from '../../lib/cron-scheduler';
import { propsToInputSchema, type PieceLookup, type PieceCatalogAction } from './piece-catalog';
import { evaluateWorkflowExpression, workflowExpressionReferences } from './safe-expression';
import { emptyInput, inputIssue } from './input-validation';
import { declaredDependencies } from './code-step-manifest';

export interface ReadinessIssue {
  node: string;
  path: string;
  code: string;
  message: string;
}
export interface RuntimeCheck extends ReadinessIssue {
  /** The boundary responsible for checking actual data before dispatch. */
  guard: 'expression' | 'piece-input' | 'tool-input' | 'loop-items' | 'connection' | 'workflow-binding';
}
export interface WorkflowReadiness {
  ready: boolean;
  issues: ReadinessIssue[];
  runtimeChecks: RuntimeCheck[];
}
export interface ReadinessContext {
  pieces?: PieceLookup;
  /** Composition may leave bindings for the editor; activation may not. */
  phase?: 'composition' | 'activation';
  /** Single-step engine execution; bindings on other draft nodes are not used. */
  preview?: { stepName: string; inputOverride?: Record<string, unknown> };
  connection?: (externalId: string, pieceName: string) => string | null;
  workflow?: (id: string) => string | null;
  tool?: (name: string) => { params: Array<{ name: string; type: string; required: boolean; enum?: string[] }> } | null;
  roles?: () => ReadonlySet<string>;
}

const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const OPERATORS = new Set([
  'TEXT_CONTAINS', 'TEXT_DOES_NOT_CONTAIN', 'TEXT_EXACTLY_MATCHES', 'TEXT_DOES_NOT_EXACTLY_MATCH',
  'TEXT_STARTS_WITH', 'TEXT_ENDS_WITH', 'TEXT_DOES_NOT_START_WITH', 'TEXT_DOES_NOT_END_WITH',
  'TEXT_MATCHES_REGEX', 'TEXT_DOES_NOT_MATCH_REGEX', 'LIST_CONTAINS', 'LIST_DOES_NOT_CONTAIN',
  'NUMBER_IS_GREATER_THAN', 'NUMBER_IS_LESS_THAN', 'NUMBER_IS_EQUAL_TO', 'BOOLEAN_IS_TRUE',
  'BOOLEAN_IS_FALSE', 'DATE_IS_AFTER', 'DATE_IS_EQUAL', 'DATE_IS_BEFORE', 'LIST_IS_EMPTY',
  'LIST_IS_NOT_EMPTY', 'EXISTS', 'DOES_NOT_EXIST',
]);
// Nested DYNAMIC fields need their own resolved schemas; the engine's saved
// property settings only address top-level dynamic properties.
const ROW_SCHEMA_TYPES = new Set(['SHORT_TEXT', 'LONG_TEXT', 'NUMBER', 'CHECKBOX', 'DATE_TIME', 'COLOR', 'STATIC_DROPDOWN', 'DROPDOWN', 'STATIC_MULTI_SELECT_DROPDOWN', 'MULTI_SELECT_DROPDOWN', 'JSON', 'OBJECT', 'ARRAY', 'FILE', 'MARKDOWN']);
const UNKNOWN_INPUT = Symbol('runtime input');
const CONNECTION_SOURCE = /^connections(?:\.([\w:-]+)|\['([^']+)'\])$/;
const UNARY = new Set(['BOOLEAN_IS_TRUE', 'BOOLEAN_IS_FALSE', 'LIST_IS_EMPTY', 'LIST_IS_NOT_EMPTY', 'EXISTS', 'DOES_NOT_EXIST']);

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
  const issues: ReadinessIssue[] = [], runtimeChecks: RuntimeCheck[] = [];
  const seen = new Set<unknown>(), names = new Set<string>();
  let count = 0, inputVisits = 0, schemaVisits = 0, runtimeCount = 0, previewFound = false;
  const issue = (node: string, path: string, code: string, message: string) => {
    if (issues.length < 100) issues.push({ node, path, code, message });
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
            const reason = context.connection?.((connection[1] ?? connection[2])!, pieceName) ?? (context.connection ? null : 'Connection inventory is unavailable');
            if (reason) issue(node, path, 'CONNECTION_BINDING', reason);
            else runtime(node, path, 'connection', 'Re-resolve this project-scoped connection before dispatch');
          }
          continue;
        }
        const refs = workflowExpressionReferences(source);
        for (const ref of refs) if (ref !== 'connections' && !scope.has(ref)) {
          issue(node, path, 'REFERENCE_SCOPE', `Reference "${ref}" is missing, later in the graph, or outside this branch/loop scope`);
        }
        if (refs.has('connections')) issue(node, path, 'CONNECTION_BINDING', "Use a complete {{connections.id}} or {{connections['id']}} binding");
        else if (refs.size) runtime(node, path, 'expression', 'Resolve data at runtime; an absent value must fail before dispatch (use an explicit fallback for optional data)');
        else evaluateWorkflowExpression(source, {}); // Catch invalid literal computations too.
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
        if (child != null) for (const name of visit(child, new Set(scope), false, depth + 1)) continuation.add(name);
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
    // Only input values are templated; source code and labels are not expressions.
    expressions(input, node, 'settings.input', scope, pieceName);
    const isPiece = (short: string) => pieceName === short || pieceName === `@jarvispieces/piece-${short}`;
    if (!root && isPiece('jarvis-tool') && settings.actionName === 'invoke' && object(input) && context.phase !== 'composition') {
      const name = staticInput(input.toolName);
      if (!name.known && context.tool) runtime(node, 'settings.input', 'tool-input', 'Resolve the tool identity and validate its parameters at governed tool dispatch');
      else if (typeof name.value !== 'string') issue(node, 'settings.input.toolName', 'TOOL_BINDING', 'Tool identity must resolve to a string');
      else {
        const tool = context.tool?.(name.value);
        if (!tool) issue(node, 'settings.input.toolName', 'TOOL_BINDING', context.tool ? 'Unknown tool' : 'Tool inventory is unavailable');
        else {
          let params = staticInput(input.params ?? {});
          if (params.known && typeof params.value === 'string') {
            try { params = { known: true, value: JSON.parse(params.value) }; } catch { /* report below */ }
          }
          if (!params.known) runtime(node, 'settings.input.params', 'tool-input', 'Tool registry validates resolved required parameters and types before execution');
          else if (!object(params.value)) issue(node, 'settings.input.params', 'INPUT_TYPE', 'Tool params must resolve to an object');
          else for (const field of tool.params) {
            const resolved = staticInput(params.value[field.name]);
            const path = `settings.input.params.${field.name}`;
            if (!resolved.known) { runtime(node, path, 'tool-input', 'Tool registry validates this parameter before execution'); continue; }
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
      try {
        if (typeof input?.cronExpression !== 'string') throw new Error('Schedule requires a static cron expression');
        validateCronExpression(input.cronExpression);
        if (typeof input.timezone !== 'string') throw new Error('Schedule requires a timezone');
        new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
      } catch (error) { issue(node, 'settings.input.cronExpression', 'CRON', (error as Error).message); }
    }
    if (type === 'PIECE' || type === 'PIECE_TRIGGER') {
      if (root && pieceName === 'schedule') {
        const cron = input?.cron_expression || input?.cronExpression || input?.expression;
        try {
          if (typeof cron !== 'string') throw new Error('Schedule requires a static cron expression');
          validateCronExpression(cron);
        } catch (error) { issue(node, 'settings.input.cron_expression', 'CRON', (error as Error).message); }
      } else if (!(root && pieceName === 'webhook')) {
        const piece = context.pieces?.get(pieceName);
        if (!piece) issue(node, 'settings.pieceName', 'PIECE', context.pieces ? `Unknown piece "${pieceName}"` : 'Piece catalog is unavailable; readiness cannot be verified');
        else {
          const key = root ? 'triggerName' : 'actionName';
          const entries = root ? piece.triggers : piece.actions;
          const sub: PieceCatalogAction | undefined = entries && typeof settings[key] === 'string' && Object.hasOwn(entries, settings[key]) ? entries[settings[key]] : undefined;
          if (!sub) issue(node, `settings.${key}`, 'ACTION', `Unknown ${key} for ${pieceName}`);
          else if (object(input)) {
            for (const field of sub.inputSchema?.fields ?? []) {
              const value = input[field.name];
              const path = `settings.input.${field.name}`;
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
            if (piece.auth && sub.requireAuth !== false && context.phase !== 'composition') {
              if (typeof input.auth !== 'string' || !/^\{\{connections(?:\.[\w:-]+|\['[^']+'\])\}\}$/.test(input.auth)) {
                issue(node, 'settings.input.auth', 'CONNECTION_BINDING', 'Select a saved connection for this authenticated action');
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
          if (raw.children[i] != null) for (const name of visit(raw.children[i], new Set(scope), false, depth + 1)) continuation.add(name);
        });
      }
    } else if (raw.children !== undefined) issue(node, 'children', 'GRAPH', 'Only ROUTER may have branch children');
    return raw.nextAction != null ? visit(raw.nextAction, continuation, false, depth) : continuation;
  }
  visit(trigger, new Set(), true);
  if (context.preview && !previewFound) issue(context.preview.stepName, 'graph', 'PREVIEW_STEP', 'The selected preview step does not exist');
  return { ready: issues.length === 0, issues, runtimeChecks };
}
