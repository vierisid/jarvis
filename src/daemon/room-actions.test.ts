/**
 * #969: ROOM_ACTIONS is what every voice path may send, so it has to be
 * exactly what the rooms' handlers do. This reads each `useRoomActions` call
 * in ui/src/v2/rooms with the TypeScript parser and compares the actions its
 * handler switches on with the table, in both directions: an action the table
 * lists that no handler runs would be offered to the voice models and answered
 * with a refusal, and a handler case the table leaves out would be dead.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  isPresentationRoomAction, isRoomAction, ROOM_ACTIONS, roomActionCategories, roomActionImpact,
  type RoomActionCategory,
} from './room-actions.ts';
import type { ActionCategory } from '../roles/authority.ts';
import {
  collapseRoomActionAliases, matchByTitle, matchEntityByName, matchProjectByName, pickRoomActionTarget, ROOM_ACTION_ALIASES,
  ROOM_ACTION_ARGS, ROOM_ACTION_DEFAULTS, ROOM_ACTION_ENTITY_TARGETS, ROOM_ACTION_TARGETS, ROOM_ACTION_TIMES, roomActionArgs, roomActionEntityArg,
  roomActionTimeArg, SETTLED_TIME_ARG, withoutEntityPin, withRoomActionDefaults,
} from './room-action-targets.ts';

// Every category the table can name is a real authority category.
const _categoryIsAuthority: ActionCategory = '' as RoomActionCategory;
void _categoryIsAuthority;

const ROOMS_DIR = new URL('../../ui/src/v2/rooms/', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** room -> the action names its handler compares `action` against. */
function handlerActions(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === 'useRoomActions'
      ) {
        const [roomArg, handler] = node.arguments;
        if (!roomArg || !ts.isStringLiteral(roomArg)) throw new Error(`${file}: useRoomActions with a non-literal room`);
        if (!handler || !(ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
          throw new Error(`${file}: useRoomActions("${roomArg.text}") with a handler this test cannot read`);
        }
        const param = handler.parameters[0]?.name;
        if (!param || !ts.isIdentifier(param)) throw new Error(`${file}: handler without an action parameter`);
        const actionName = param.text;
        const isAction = (e: ts.Expression) => ts.isIdentifier(e) && e.text === actionName;
        const actions: string[] = [];
        const walk = (n: ts.Node): void => {
          if (ts.isSwitchStatement(n) && isAction(n.expression)) {
            for (const clause of n.caseBlock.clauses) {
              if (!ts.isCaseClause(clause)) continue;
              if (!ts.isStringLiteral(clause.expression)) throw new Error(`${file}: non-literal case on ${actionName}`);
              actions.push(clause.expression.text);
            }
          }
          if (
            ts.isBinaryExpression(n)
            && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind)
          ) {
            const lit = isAction(n.left) ? n.right : isAction(n.right) ? n.left : null;
            if (lit) {
              if (!ts.isStringLiteral(lit)) throw new Error(`${file}: ${actionName} compared with a non-literal`);
              actions.push(lit.text);
            }
          }
          ts.forEachChild(n, walk);
        };
        walk(handler.body);
        const room = roomArg.text;
        if (found[room]) throw new Error(`two handlers for "${room}"`);
        found[room] = [...new Set(actions)].sort();
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('ROOM_ACTIONS matches the rooms\' handlers', () => {
  test('every room handler carries out exactly the actions listed for it, and no unlisted room has one', () => {
    const fromHandlers = handlerActions();
    const fromTable = Object.fromEntries(Object.entries(ROOM_ACTIONS).map(([r, a]) => [r, Object.keys(a).sort()]));
    // Not vacuous: the parser found the rooms and their cases.
    expect(Object.keys(fromHandlers).length).toBeGreaterThanOrEqual(12);
    expect(fromHandlers.settings!.length).toBeGreaterThan(10);
    expect(fromHandlers).toEqual(fromTable);
  });

  test('authority takes no grant or revoke from any room action', () => {
    expect(isRoomAction('authority', 'grant_access')).toBe(false);
    expect(isRoomAction('authority', 'revoke_access')).toBe(false);
    expect(isRoomAction('authority', 'switch_tab')).toBe(true);
  });

  test('isRoomAction fails closed', () => {
    expect(isRoomAction('settings', 'enable_tts')).toBe(true);
    expect(isRoomAction('settings', 'set_primary_llm')).toBe(false);
    expect(isRoomAction('usage', 'switch_tab')).toBe(false);
    expect(isRoomAction('__proto__', 'toString')).toBe(false);
    expect(isRoomAction('constructor', 'name')).toBe(false);
    expect(isRoomAction('settings', undefined)).toBe(false);
    expect(isRoomAction('settings', ['enable_tts'])).toBe(false);
  });
});

/**
 * room -> action -> whether the code that runs it does work beyond the screen.
 * Work is an async function or an await, a `.then`, a fetch, or a call on
 * what a `use...Data` / `use...Feed` hook returned (`data.createTask`, or a
 * method destructured from it) other than a lookup or a re-read. Calls to
 * helpers the file defines are followed, sync or async (openProject,
 * handleSpawn), and code in the handler outside its `switch` counts for every
 * action. A `case` with no statements of its own runs the next one's code.
 *
 * It reads syntax in one file, so it does not see an effect a state change
 * sets off (a useEffect on the selected project), or one inside a function
 * imported from another file that the handler calls outside an async block.
 */
// goToWeek and goToToday move the week the calendar shows.
const PURE_HOOK_CALL = /^(find\w*|refresh|toggleSource|setTimeWindow|setLiveTail|goToWeek|goToToday)$/;

/**
 * What counts as work in one room file (see handlerEffects): `sites` are the
 * outermost nodes under `nodes` that do work, each an await or an async
 * function, a `.then`, a fetch, a call on a `use...Data` / `use...Feed`
 * hook's result other than a lookup or a re-read, or a call to a helper the
 * file defines whose body does work.
 */
function effectModel(sf: ts.SourceFile): {
  sites: (nodes: readonly ts.Node[]) => ts.Node[];
  effectful: (nodes: readonly ts.Node[]) => boolean;
} {
  const isFn = (n: ts.Node | undefined): n is ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration => !!n
    && (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n));
  const isAsyncFn = (n: ts.Node | undefined): boolean => isFn(n)
    && !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const isHookCall = (n: ts.Expression | undefined): boolean => !!n && ts.isCallExpression(n)
    && ts.isIdentifier(n.expression) && /^use\w*(Data|Feed)$/.test(n.expression.text);
  const helpers = new Map<string, ts.Node>();
  const hookObjects = new Set<string>();
  const hookMethods = new Set<string>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const init = n.initializer;
      if (ts.isIdentifier(n.name)) {
        const wrapped = ts.isCallExpression(init) ? init.arguments[0] : undefined;
        if (isFn(init)) helpers.set(n.name.text, init);
        else if (isFn(wrapped)) helpers.set(n.name.text, wrapped);
        if (isHookCall(init)) hookObjects.add(n.name.text);
      } else if (ts.isObjectBindingPattern(n.name) && isHookCall(init)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) hookMethods.add(el.name.text);
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name) helpers.set(n.name.text, n);
    ts.forEachChild(n, collect);
  };
  collect(sf);
  // Helpers being read, so one that calls itself, or another that calls it
  // back, is not followed round. Not a cache: a helper read while another
  // was mid-read could be answered wrongly, and the answer kept.
  const reading = new Set<string>();
  const isWork = (n: ts.Node): boolean => {
    if (ts.isAwaitExpression(n) || isAsyncFn(n)) return true;
    if (!ts.isCallExpression(n)) return false;
    const callee = n.expression;
    if (ts.isIdentifier(callee)) {
      const name = callee.text;
      if (name === 'fetch' || (hookMethods.has(name) && !PURE_HOOK_CALL.test(name))) return true;
      const helper = helpers.get(name);
      if (helper && !reading.has(name)) {
        reading.add(name);
        const works = sites([helper]).length > 0;
        reading.delete(name);
        if (works) return true;
      }
    }
    if (ts.isPropertyAccessExpression(callee)) {
      // Any link of a promise chain: work reached through it settles later.
      if (['then', 'catch', 'finally'].includes(callee.name.text)) return true;
      if (ts.isIdentifier(callee.expression) && hookObjects.has(callee.expression.text)
        && !PURE_HOOK_CALL.test(callee.name.text)) return true;
    }
    return false;
  };
  const sites = (nodes: readonly ts.Node[]): ts.Node[] => {
    const out: ts.Node[] = [];
    const walk = (n: ts.Node): void => {
      if (isWork(n)) { out.push(n); return; }
      ts.forEachChild(n, walk);
    };
    nodes.forEach(walk);
    return out;
  };
  return { sites, effectful: (nodes) => sites(nodes).length > 0 };
}

function handlerEffects(): Record<string, Record<string, boolean>> {
  const found: Record<string, Record<string, boolean>> = {};
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const { effectful } = effectModel(sf);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useRoomActions') {
        const [roomArg, handler] = node.arguments as unknown as [ts.StringLiteral, ts.ArrowFunction];
        const room = roomArg.text;
        const actions: Record<string, boolean> = {};
        const param = (handler.parameters[0]!.name as ts.Identifier).text;
        const isAction = (e: ts.Expression) => ts.isIdentifier(e) && e.text === param;
        const body = ts.isBlock(handler.body) ? handler.body.statements : [handler.body];
        const switches = body.filter((st): st is ts.SwitchStatement => ts.isSwitchStatement(st) && isAction(st.expression));
        if (switches.length === 1) {
          // Whatever runs around the switch runs for every action.
          const around = effectful(body.filter((st) => st !== switches[0]));
          const clauses = switches[0]!.caseBlock.clauses;
          clauses.forEach((clause, i) => {
            if (!ts.isCaseClause(clause)) return;
            let j = i;
            while (j < clauses.length - 1 && clauses[j]!.statements.length === 0) j += 1;
            actions[(clause.expression as ts.StringLiteral).text] = around || effectful(clauses[j]!.statements);
          });
        } else if (switches.length === 0) {
          // A one-action handler (`if (action !== "x") return false; ...`):
          // the body is that action's code.
          const only = Object.keys(ROOM_ACTIONS[room as keyof typeof ROOM_ACTIONS] ?? {});
          if (only.length !== 1) throw new Error(`${file}: cannot tell which code runs which action`);
          actions[only[0]!] = effectful(body);
        } else {
          throw new Error(`${file}: more than one switch on the action`);
        }
        found[room] = actions;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

describe('each room action\'s impact matches what its handler does (#973, #974)', () => {
  test('a view action does no work beyond the screen, and every other action does some', () => {
    const effects = handlerEffects();
    const wrong: string[] = [];
    let views = 0;
    let effectful = 0;
    for (const [room, actions] of Object.entries(effects)) {
      for (const [action, doesWork] of Object.entries(actions)) {
        const view = isPresentationRoomAction(room, action);
        if (view) views += 1; else effectful += 1;
        if (view === doesWork) wrong.push(`${room}/${action}: listed ${view ? 'view' : 'side-effecting'}, handler ${doesWork ? 'does work' : 'only changes the screen'}`);
      }
    }
    // Not vacuous: both kinds are present in numbers.
    expect(views).toBeGreaterThan(25);
    expect(effectful).toBeGreaterThan(25);
    expect(wrong).toEqual([]);
  });

  test('opening a stopped project counts as running a command', () => {
    // openProject starts the dev server; the classification is the worst case.
    expect(roomActionCategories('workspaces', 'select_project')).toEqual(['execute_command']);
    expect(isPresentationRoomAction('workspaces', 'switch_view')).toBe(true);
  });

  test('an action the table does not list has no impact, and is never presentation', () => {
    expect(roomActionImpact('settings', 'set_primary_llm')).toBeNull();
    expect(isPresentationRoomAction('settings', 'set_primary_llm')).toBe(false);
    expect(isPresentationRoomAction('__proto__', 'toString')).toBe(false);
    expect(isPresentationRoomAction('settings', 'hasOwnProperty')).toBe(false);
    expect(roomActionCategories('usage', 'switch_tab')).toEqual([]);
  });
});

/**
 * room -> action -> the code that runs it, with the handler's name for its
 * arguments. A `case` with no statements runs the next one's code; a handler
 * with no switch is its one action's code.
 */
function handlerCode(): Record<string, Record<string, { nodes: readonly ts.Node[]; args: string }>> {
  const found: Record<string, Record<string, { nodes: readonly ts.Node[]; args: string }>> = {};
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useRoomActions') {
        const [roomArg, handler] = node.arguments as unknown as [ts.StringLiteral, ts.ArrowFunction];
        const room = roomArg.text;
        const action = (handler.parameters[0]!.name as ts.Identifier).text;
        const argParam = handler.parameters[1]?.name;
        if (argParam && !ts.isIdentifier(argParam)) throw new Error(`${file}: a handler whose arguments this test cannot follow`);
        const args = argParam ? argParam.text : 'args';
        const body = ts.isBlock(handler.body) ? handler.body.statements : [handler.body];
        const sw = body.find((st): st is ts.SwitchStatement => ts.isSwitchStatement(st)
          && ts.isIdentifier(st.expression) && st.expression.text === action);
        const actions: Record<string, { nodes: readonly ts.Node[]; args: string }> = {};
        if (sw) {
          const clauses = sw.caseBlock.clauses;
          clauses.forEach((clause, i) => {
            if (!ts.isCaseClause(clause)) return;
            let j = i;
            while (j < clauses.length - 1 && clauses[j]!.statements.length === 0) j += 1;
            actions[(clause.expression as ts.StringLiteral).text] = { nodes: clauses[j]!.statements, args };
          });
        } else {
          const only = Object.keys(ROOM_ACTIONS[room as keyof typeof ROOM_ACTIONS] ?? {});
          actions[only[0]!] = { nodes: body, args };
        }
        found[room] = actions;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

/** Every node under `nodes` that `match` picks. */
function findAll<T>(nodes: readonly ts.Node[], match: (n: ts.Node) => T | null): T[] {
  const out: T[] = [];
  const walk = (n: ts.Node): void => {
    const m = match(n);
    if (m !== null) out.push(m);
    ts.forEachChild(n, walk);
  };
  nodes.forEach(walk);
  return out;
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x)) x = x.expression;
  return x;
};

/**
 * A default written into a handler: `args.x ?? <literal>`, or
 * `typeof args.x === ... ? args.x : <literal>`, where the literal is a
 * non-empty string, a number, a boolean or null. An empty string or undefined
 * is the argument being absent, which the handler then refuses or leaves to
 * the daemon's own default; it does not change what runs.
 */
function inlineDefaults(nodes: readonly ts.Node[], args: string): string[] {
  const argOf = (e: ts.Expression): string | null => argName(e, args);
  const literal = (e: ts.Expression): string | null => {
    const x = unwrap(e);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return x.text === '' ? null : JSON.stringify(x.text);
    if (ts.isNumericLiteral(x)) return x.text;
    if (x.kind === ts.SyntaxKind.TrueKeyword) return 'true';
    if (x.kind === ts.SyntaxKind.FalseKeyword) return 'false';
    if (x.kind === ts.SyntaxKind.NullKeyword) return 'null';
    return null;
  };
  return findAll(nodes, (n) => {
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const a = argOf(n.left);
      const d = literal(n.right);
      if (a && d) return `${a}=${d}`;
    }
    if (ts.isConditionalExpression(n)) {
      // Either way round: `... ? args.x : "d"` or `... ? "d" : args.x`.
      for (const [arg, lit] of [[n.whenTrue, n.whenFalse], [n.whenFalse, n.whenTrue]] as const) {
        const a = argOf(arg);
        const d = literal(lit);
        if (a && d) return `${a}=${d}`;
      }
    }
    // `const { x = "d" } = args`
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(unwrap(n.initializer))
      && (unwrap(n.initializer) as ts.Identifier).text === args && ts.isObjectBindingPattern(n.name)) {
      for (const el of n.name.elements) {
        const d = el.initializer ? literal(el.initializer) : null;
        const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : '?';
        if (d) return `${key}=${d}`;
      }
    }
    return null;
  });
}

/** `args.x` or `args["x"]` as "x", else null. */
function argName(e: ts.Expression, args: string): string | null {
  const x = unwrap(e);
  if (ts.isPropertyAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === args) return x.name.text;
  if (ts.isElementAccessExpression(x) && ts.isIdentifier(x.expression) && x.expression.text === args
    && ts.isStringLiteral(x.argumentExpression)) return x.argumentExpression.text;
  return null;
}

/**
 * Every argument the code in `nodes` reads from `args` (#1021): `args.x`,
 * `args?.x`, `args["x"]`, a destructured `const { x } = args`, and through
 * the shared helpers, `pickRoomActionTarget(list, args, ...)` (id and name)
 * and `withRoomActionDefaults(room, action, args)` (that action's defaults).
 * Any other use of `args` throws, so a way of reading it this does not
 * follow fails the test rather than passing it.
 */
function argReads(nodes: readonly ts.Node[], args: string): string[] {
  const out = new Set<string>();
  const where = (n: ts.Node) => n.getText().replace(/\s+/g, ' ').slice(0, 60);
  findAll(nodes, (n) => {
    if (!(ts.isIdentifier(n) && n.text === args)) return null;
    let use: ts.Node = n;
    while (ts.isParenthesizedExpression(use.parent) || ts.isAsExpression(use.parent) || ts.isNonNullExpression(use.parent)) use = use.parent;
    const p = use.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === use) { out.add(p.name.text); return null; }
    if (ts.isElementAccessExpression(p) && p.expression === use) {
      if (!ts.isStringLiteral(p.argumentExpression)) throw new Error(`args read by a computed key: ${where(p)}`);
      out.add(p.argumentExpression.text);
      return null;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === use && ts.isObjectBindingPattern(p.name)) {
      for (const el of p.name.elements) {
        if (el.dotDotDotToken) throw new Error(`args spread: ${where(p)}`);
        const key = el.propertyName ?? el.name;
        if (!ts.isIdentifier(key)) throw new Error(`args destructured by a computed key: ${where(p)}`);
        out.add(key.text);
      }
      return null;
    }
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression)) {
      const at = p.arguments.indexOf(use as ts.Expression);
      if (p.expression.text === 'pickRoomActionTarget' && at === 1) { out.add('id'); out.add('name'); return null; }
      if (p.expression.text === 'withRoomActionDefaults' && at === 2) {
        const [r, a] = p.arguments;
        if (!r || !a || !ts.isStringLiteral(r) || !ts.isStringLiteral(a)) throw new Error(`withRoomActionDefaults with a non-literal action: ${where(p)}`);
        for (const k of Object.keys(ROOM_ACTION_DEFAULTS[r.text]?.[a.text] ?? {})) out.add(k);
        // It hands back every argument with the defaults filled in, so what
        // is read off it is an argument too; any other use is not followed.
        let res: ts.Node = p;
        while (ts.isParenthesizedExpression(res.parent) || ts.isAsExpression(res.parent) || ts.isNonNullExpression(res.parent)) res = res.parent;
        const q = res.parent;
        if (ts.isPropertyAccessExpression(q) && q.expression === res) out.add(q.name.text);
        else if (ts.isElementAccessExpression(q) && q.expression === res && ts.isStringLiteral(q.argumentExpression)) out.add(q.argumentExpression.text);
        else throw new Error(`withRoomActionDefaults result used in a way this test cannot follow: ${where(q)}`);
        return null;
      }
    }
    // The handler's own parameter.
    if (ts.isParameter(p)) return null;
    throw new Error(`args used in a way this test cannot follow: ${where(p)}`);
  });
  return [...out].sort();
}

/**
 * Where a case lets one argument stand in for another:`args.a ?? args.b`,
 * `args.a || args.b`, or `args.a ? ... : <something reading args.b>`. The
 * daemon must collapse those before a card (ROOM_ACTION_ALIASES), or the card
 * shows both and the handler runs one.
 */
function argAliases(nodes: readonly ts.Node[], args: string): string[] {
  const reads = (n: ts.Node): string[] => findAll([n], (m) => (ts.isExpression(m) ? argName(m, args) : null));
  return findAll(nodes, (n) => {
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      const a = argName(n.left, args);
      const b = argName(n.right, args);
      if (a && b && a !== b) return `${a}|${b}`;
    }
    if (ts.isConditionalExpression(n)) {
      const a = argName(n.condition, args);
      const other = a ? reads(n.whenFalse).filter((b) => b !== a) : [];
      if (a && other.length > 0) return `${a}|${[...new Set(other)].join('+')}`;
    }
    return null;
  });
}

/**
 * Where a side-effecting case reaches for an item other than through
 * pickRoomActionTarget(<list>, args, ...): the selection by name, or a
 * `.find(` on a list. Either would ignore a pinned id.
 */
function unpinnedLookups(nodes: readonly ts.Node[], args: string): string[] {
  const inPicker = new Set<ts.Node>();
  findAll(nodes, (n) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'pickRoomActionTarget') {
      findAll([n], (m) => { inPicker.add(m); return null; });
    }
    return null;
  });
  return findAll(nodes, (n) => {
    if (inPicker.has(n)) return null;
    if (ts.isIdentifier(n) && (n.text === 'selected' || n.text === 'activeProject')) return n.text;
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && ['find', 'findByName', 'findByTitle'].includes(n.expression.name.text)) return `.${n.expression.name.text}(`;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)
      && ['matchProjectByName', 'matchByTitle'].includes(n.expression.text)) return `${n.expression.text}(`;
    return null;
  }).concat(findAll(nodes, (n) => {
    // The picker is handed the case's own arguments, so a pinned id reaches it.
    if (!(ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'pickRoomActionTarget')) return null;
    const second = n.arguments[1];
    return second && ts.isIdentifier(second) && second.text === args ? null : 'pickRoomActionTarget(<not args>)';
  }));
}

/** The (room, action) every call to `fn` in `nodes` names, as "room/action". */
function callsTo(nodes: readonly ts.Node[], fn: string, withLiterals: boolean): string[] {
  return findAll(nodes, (n) => {
    if (!ts.isCallExpression(n)) return null;
    const callee = n.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
    if (name !== fn) return null;
    if (!withLiterals) return fn;
    const [r, a] = n.arguments;
    return r && a && ts.isStringLiteral(r) && ts.isStringLiteral(a) ? `${r.text}/${a.text}` : '<non-literal>';
  });
}

const tableEntries = (table: Record<string, Record<string, unknown>>) =>
  Object.entries(table).flatMap(([room, actions]) => Object.keys(actions).map((a) => `${room}/${a}`)).sort();

describe('what a held room action does is decided before the card, from the handlers\' own tables (#1008)', () => {
  const code = handlerCode();
  const sideEffecting = Object.entries(code).flatMap(([room, actions]) =>
    Object.entries(actions).filter(([action]) => !isPresentationRoomAction(room, action)).map(([action, c]) => ({ room, action, ...c })));

  test('no side-effecting case supplies a default of its own: each one is in ROOM_ACTION_DEFAULTS, and its case uses it', () => {
    // Not vacuous: the cases were read.
    expect(sideEffecting.length).toBeGreaterThan(25);
    const inline = sideEffecting.flatMap(({ room, action, nodes, args }) => inlineDefaults(nodes, args).map((d) => `${room}/${action}: ${d}`));
    expect(inline).toEqual([]);
    const users = sideEffecting.flatMap(({ room, action, nodes }) =>
      callsTo(nodes, 'withRoomActionDefaults', true).map((named) => {
        // A case reads its own defaults, never another action's.
        expect(named).toBe(`${room}/${action}`);
        return named;
      }));
    expect([...new Set(users)].sort()).toEqual(tableEntries(ROOM_ACTION_DEFAULTS));
    expect(users.length).toBeGreaterThanOrEqual(4);
  });

  test('the detector sees a default written inline', () => {
    const sf = ts.createSourceFile('x.tsx', [
      'const a = typeof args.template === "string" ? args.template : "vite-react";',
      'const b = String(args.scope ?? "all");',
      'const c = (args.level as GoalLevel) ?? "task";',
      'const d = (args.agent as string) ?? null;',
      'const e = typeof args.name === "string" ? args.name : "";',
      'const f = (args.priority as P) ?? undefined;',
      'const g = args.voice || "alloy";',
      'const h = typeof args.mode !== "string" ? "fast" : args.mode;',
      'const { size = 3, color: c = "red", other } = args;',
      'const i = args["tone"] ?? `warm`;',
    ].join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(inlineDefaults(sf.statements, 'args')).toEqual([
      'template="vite-react"', 'scope="all"', 'level="task"', 'agent=null', 'voice="alloy"', 'mode="fast"', 'size=3', 'tone="warm"',
    ]);
  });

  test('every argument a side-effecting case lets stand in for another is collapsed before the card, and only those', () => {
    const found = sideEffecting.filter(({ nodes, args }) => argAliases(nodes, args).length > 0)
      .map(({ room, action }) => `${room}/${action}`).sort();
    expect(found).toEqual(tableEntries(ROOM_ACTION_ALIASES));
    expect(found.length).toBeGreaterThanOrEqual(3);
    const sf = ts.createSourceFile('x.tsx', 'const a = String(args.provider ?? args.name ?? ""); const r = args.ref ? String(args.ref) : args.p && args.m ? 1 : 2;',
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(argAliases(sf.statements, 'args')).toEqual(['provider|name', 'ref|p+m']);
  });

  test('the alias collapse keeps the argument the handler runs', () => {
    expect(collapseRoomActionAliases('settings', 'set_default_model', { ref: 'a:b', provider: 'x', model: 'y' })).toEqual({ ref: 'a:b' });
    expect(collapseRoomActionAliases('settings', 'set_model', { provider: 'x', model: 'y' })).toEqual({ ref: 'x:y' });
    expect(collapseRoomActionAliases('settings', 'set_model', { provider: 'x' })).toEqual({});
    expect(collapseRoomActionAliases('settings', 'test_provider', { provider: 'openai', name: 'groq' })).toEqual({ provider: 'openai' });
    expect(collapseRoomActionAliases('settings', 'test_provider', { name: 'groq' })).toEqual({ provider: 'groq' });
    const args = { title: 'x' };
    expect(collapseRoomActionAliases('tasks', 'create_task', args)).toBe(args);
  });

  test('every side-effecting case that picks an item goes through pickRoomActionTarget with its own arguments, and only those in ROOM_ACTION_TARGETS', () => {
    // A direct lookup, or the selection used outside the picker, would ignore
    // a pinned id; so would a picker handed anything but the case's args.
    const direct = sideEffecting.flatMap(({ room, action, nodes, args }) => unpinnedLookups(nodes, args).map((f) => `${room}/${action}: ${f}`));
    expect(direct).toEqual([]);
    const sf = ts.createSourceFile('x.tsx', [
      'const a = pickRoomActionTarget(data.items, args, data.findByName, selected);',
      'const b = data.projects.find((p) => p.id === x);',
      'const c = pickRoomActionTarget(data.items, { name: args.name }, data.findByName);',
      'go(activeProject);',
    ].join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(unpinnedLookups(sf.statements, 'args')).toEqual(['.find(', 'activeProject', 'pickRoomActionTarget(<not args>)']);
    const pickers = sideEffecting.filter(({ nodes }) => callsTo(nodes, 'pickRoomActionTarget', false).length > 0)
      .map(({ room, action }) => `${room}/${action}`).sort();
    expect(pickers).toEqual(tableEntries(ROOM_ACTION_TARGETS));
    expect(pickers.length).toBeGreaterThanOrEqual(9);
  });

  test('each target kind is the item its room holds', () => {
    const kinds = Object.fromEntries(Object.entries(ROOM_ACTION_TARGETS).map(([room, a]) => [room, [...new Set(Object.values(a))]]));
    expect(kinds).toEqual({ workspaces: ['project'], content: ['content'], tasks: ['task'] });
    for (const entry of tableEntries(ROOM_ACTION_TARGETS)) {
      const [room, action] = entry.split('/') as [string, string];
      expect([entry, isPresentationRoomAction(room, action), isRoomAction(room, action)]).toEqual([entry, false, true]);
    }
    for (const entry of tableEntries(ROOM_ACTION_DEFAULTS)) {
      const [room, action] = entry.split('/') as [string, string];
      expect([entry, isPresentationRoomAction(room, action), isRoomAction(room, action)]).toEqual([entry, false, true]);
    }
  });
});

/** room -> every argument its handler reads outside the switch on the action, which every action would read. */
function argReadsAroundSwitch(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const call of findAll([sf], (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useRoomActions' ? n : null))) {
      const handler = call.arguments[1] as ts.ArrowFunction;
      const body = ts.isBlock(handler.body) ? handler.body.statements : [handler.body];
      if (!body.some((st) => ts.isSwitchStatement(st))) continue;
      const argParam = handler.parameters[1]?.name;
      found[(call.arguments[0] as ts.StringLiteral).text] = argParam && ts.isIdentifier(argParam)
        ? argReads(body.filter((st) => !ts.isSwitchStatement(st)), argParam.text) : [];
    }
  }
  return found;
}

/**
 * What handlerCode cannot attribute to one action (#1021 review): a `default`
 * clause that reads an argument, and a case with code of its own that falls
 * into the next one, whose reads would be credited to the wrong action.
 */
function unattributedArgReads(): string[] {
  const ends = (st: ts.Statement | undefined): boolean => {
    if (!st) return false;
    if (ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isBreakStatement(st)) return true;
    if (ts.isBlock(st)) return ends(st.statements[st.statements.length - 1]);
    if (ts.isIfStatement(st)) return !!st.elseStatement && ends(st.thenStatement) && ends(st.elseStatement);
    return false;
  };
  const out: string[] = [];
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const call of findAll([sf], (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useRoomActions' ? n : null))) {
      const handler = call.arguments[1] as ts.ArrowFunction;
      const room = (call.arguments[0] as ts.StringLiteral).text;
      const argParam = handler.parameters[1]?.name;
      const args = argParam && ts.isIdentifier(argParam) ? argParam.text : 'args';
      for (const sw of findAll([handler.body], (n) => (ts.isSwitchStatement(n) ? n : null))) {
        sw.caseBlock.clauses.forEach((clause, i) => {
          const label = ts.isCaseClause(clause) ? clause.expression.getText() : 'default';
          if (!ts.isCaseClause(clause)) {
            const reads = argReads(clause.statements, args);
            if (reads.length > 0) out.push(`${room} default reads ${reads.join(', ')}`);
            return;
          }
          const last = i === sw.caseBlock.clauses.length - 1;
          if (clause.statements.length > 0 && !last && !ends(clause.statements[clause.statements.length - 1])) out.push(`${room} ${label} falls through`);
        });
      }
    }
  }
  return out;
}

/** Each argument a case checks with `typeof args.x === "t"`, as "x: t". */
function typeofChecks(nodes: readonly ts.Node[], args: string): string[] {
  return findAll(nodes, (n) => {
    if (!(ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind))) return null;
    for (const [a, b] of [[n.left, n.right], [n.right, n.left]] as const) {
      const t = unwrap(a);
      if (ts.isTypeOfExpression(t) && ts.isStringLiteral(unwrap(b))) {
        const name = argName(t.expression, args);
        if (name) return `${name}: ${(unwrap(b) as ts.StringLiteral).text}`;
      }
    }
    return null;
  });
}

describe('a room action carries only the arguments its handler reads (#1021)', () => {
  const code = handlerCode();

  test('ROOM_ACTION_ARGS lists exactly the arguments each case reads, for every action', () => {
    const fromHandlers: Record<string, string[]> = {};
    const fromTable: Record<string, string[]> = {};
    for (const [room, actions] of Object.entries(code)) {
      for (const [action, { nodes, args }] of Object.entries(actions)) {
        fromHandlers[`${room}/${action}`] = argReads(nodes, args);
        fromTable[`${room}/${action}`] = Object.keys(ROOM_ACTION_ARGS[room]?.[action] ?? { '<not in ROOM_ACTION_ARGS>': [] }).sort();
      }
    }
    // Not vacuous: every action in ROOM_ACTIONS was read, and most read something.
    expect(Object.keys(fromHandlers).sort()).toEqual(tableEntries(ROOM_ACTIONS));
    expect(Object.values(fromHandlers).filter((a) => a.length > 0).length).toBeGreaterThan(45);
    expect(fromHandlers).toEqual(fromTable);
    // And the table names no action the handlers do not carry out.
    expect(tableEntries(ROOM_ACTION_ARGS)).toEqual(tableEntries(ROOM_ACTIONS));
    // Nothing outside a switch reads an argument for every action at once.
    const around = argReadsAroundSwitch();
    expect(Object.keys(around).length).toBeGreaterThanOrEqual(11);
    expect(Object.values(around).flat()).toEqual([]);
    expect(unattributedArgReads()).toEqual([]);
  });

  test('an argument a case checks the type of takes only that type', () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const [room, actions] of Object.entries(code)) {
      for (const [action, { nodes, args }] of Object.entries(actions)) {
        const byArg = new Map<string, Set<string>>();
        for (const c of typeofChecks(nodes, args)) {
          const [name, type] = c.split(': ') as [string, string];
          byArg.set(name, (byArg.get(name) ?? new Set()).add(type));
        }
        for (const [name, types] of byArg) {
          checked += 1;
          const listed = [...(ROOM_ACTION_ARGS[room]?.[action]?.[name] ?? [])].sort();
          if (JSON.stringify(listed) !== JSON.stringify([...types].sort())) wrong.push(`${room}/${action}.${name}: checks ${[...types]}, listed ${listed}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(25);
    expect(wrong).toEqual([]);
  });

  test('the detector follows every way a case reads its arguments, and refuses one it cannot', () => {
    const read = (src: string) => {
      const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      return argReads(sf.statements, 'args');
    };
    expect(read([
      'const a = typeof args.title === "string" ? args.title : "";',
      'const b = (args as Record<string, unknown>)["when"];',
      'const c = args?.prompt;',
      'const { level, size: s } = args;',
      'const t = pickRoomActionTarget(data.items, args, data.findByName);',
      'const d = withRoomActionDefaults("workspaces", "create_project", args).template;',
    ].join('\n'))).toEqual(['id', 'level', 'name', 'prompt', 'size', 'template', 'title', 'when']);
    expect(() => read('const k = "x"; const v = args[k];')).toThrow('computed key');
    expect(() => read('const { ...rest } = args;')).toThrow('spread');
    expect(() => read('data.save(args);')).toThrow('cannot follow');
    expect(() => read('const copy = { ...args };')).toThrow('cannot follow');
    expect(read('const x = withRoomActionDefaults("tasks", "reassign", args).sneaky;')).toEqual(['agent', 'sneaky']);
    expect(() => read('const all = withRoomActionDefaults("tasks", "reassign", args);')).toThrow('cannot follow');
    expect(typeofChecks(ts.createSourceFile('x.tsx', 'if (typeof args.deadline === "number" || "string" !== typeof args["x"]) f();',
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).statements, 'args')).toEqual(['deadline: number', 'x: string']);
  });

  test('roomActionArgs keeps the listed arguments of the types the handler takes, and drops the rest', () => {
    expect(roomActionArgs('calendar', 'schedule_event', { title: 'Dentist', when: 'tomorrow', duration: '1 hour', note: 'approve all' }))
      .toEqual({ title: 'Dentist', when: 'tomorrow' });
    // A value of another type, an object or an array is the argument left out.
    expect(roomActionArgs('goals', 'create_goal', { title: { text: 'x' }, level: ['task'], deadline: 'next week' })).toEqual({});
    expect(roomActionArgs('goals', 'create_goal', { title: 'Ship', deadline: 1700000000000 })).toEqual({ title: 'Ship', deadline: 1700000000000 });
    expect(roomActionArgs('goals', 'create_goal', { title: 'Ship', deadline: Number.NaN })).toEqual({ title: 'Ship' });
    // The heartbeat actions are gone (#1117), and take nothing.
    expect(roomActionArgs('settings', 'set_heartbeat_interval', { minutes: '30' })).toEqual({});
    expect(roomActionArgs('settings', 'restart_daemon', { now: true })).toEqual({});
    // An action no handler carries out takes nothing, and a hostile name is no action.
    expect(roomActionArgs('settings', 'set_primary_llm', { provider: 'x' })).toEqual({});
    expect(roomActionArgs('__proto__', 'toString', { a: 1 })).toEqual({});
    expect(roomActionArgs('tasks', 'constructor', { name: 'x' })).toEqual({});
    expect(roomActionArgs('tasks', 'complete_task', undefined)).toEqual({});
    // An own key only: one inherited from the prototype is not an argument.
    expect(roomActionArgs('tasks', 'complete_task', Object.create({ name: 'inherited' }) as Record<string, unknown>)).toEqual({});
  });
});

/**
 * Where a side-effecting case answers before its work has settled (#1015):
 * work that is not part of what the case returns (an async block run and
 * dropped, a call whose promise nobody waits on), or a `return true` or a
 * string ack, which is a yes whatever the request then does. Every case that
 * changes more than the screen must hand the bus the promise of its work and
 * answer from how that settled; spawn_agent did since #991, and the others
 * said yes as the request went out, so voice confirmed failed saves, a PATCH
 * that always answered 400 (#1020) and a heartbeat write with no endpoint.
 *
 * The same holds inside what is returned: in a `.then` / `.catch` /
 * `.finally` callback, or an async function the case returns, work must be
 * awaited or returned there, or it runs on after the answer (the old
 * create_project opened the project it made that way). Work inside a
 * function the case only defines or passes elsewhere is not answered for.
 *
 * It reads one file's syntax, as handlerEffects does: work inside a helper
 * the case returns is not looked into, and a call to a function imported
 * from another file is not seen as work. Anything written under a return or
 * an await counts as kept, so `return (data.save(), true)`, `return
 * data.save() && true` and `return void data.save()` pass, and the
 * callbacks of a call that is not a promise chain (`Promise.all(xs.map(...))`)
 * are not looked into; a promise put in a variable and awaited later is
 * flagged. No room handler is written any of those ways.
 */
function earlyAnswers(nodes: readonly ts.Node[]): string[] {
  if (nodes.length === 0) return [];
  const { sites } = effectModel(nodes[0]!.getSourceFile());
  const isFnNode = (n: ts.Node): n is ts.FunctionLikeDeclaration => ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
  const brief = (n: ts.Node) => n.getText().replace(/\s+/g, ' ').slice(0, 50);
  const out: string[] = [];
  // Whether `site` is kept by `owner` (the case, or a function inside what
  // it returns): returned or awaited by it, or an arrow's whole body.
  const kept = (site: ts.Node, owner: ts.Node): boolean => {
    if (ts.isAwaitExpression(site) && enclosing(site) === owner) return true;
    for (let n: ts.Node = site; n !== owner; n = n.parent) {
      const p = n.parent;
      if (!p) return false;
      if (p === owner && isFnNode(owner) && owner.body === n && !ts.isBlock(n)) return true;
      if (isFnNode(p) && p !== owner) return false;
      if ((ts.isReturnStatement(p) || ts.isAwaitExpression(p)) && enclosing(p) === owner) return true;
    }
    return false;
  };
  const enclosing = (n: ts.Node): ts.Node | undefined => {
    for (let p = n.parent; p; p = p.parent) if (isFnNode(p) || p === caseOwner) return p;
    return undefined;
  };
  const caseOwner = nodes[0]!.parent;
  // Look inside what a kept site hands back: the callbacks of a promise
  // chain, every link of it, and the body of an async function.
  const inside = (site: ts.Node): void => {
    const x = ts.isAwaitExpression(site) ? unwrap(site.expression) : site;
    if (isFnNode(x)) { check(x.body ? [x.body] : [], x); return; }
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && ['then', 'catch', 'finally'].includes(x.expression.name.text)) {
      for (const arg of x.arguments) if (isFnNode(arg)) check(arg.body ? [arg.body] : [], arg);
      inside(unwrap(x.expression.expression));
      return;
    }
    // An async function called where it is defined, (async () => {...})().
    if (ts.isCallExpression(x) && isFnNode(unwrap(x.expression))) inside(unwrap(x.expression));
  };
  const check = (body: readonly ts.Node[], owner: ts.Node): void => {
    for (const site of sites(body)) {
      if (!kept(site, owner)) out.push(`work outside the answer: ${brief(site)}`);
      else inside(site);
    }
  };
  check(nodes, caseOwner);
  // A yes of the case's own, not of a function inside it.
  const ownReturn = (r: ts.Node): boolean => {
    for (let n = r.parent; n && n !== caseOwner; n = n.parent) if (isFnNode(n)) return false;
    return true;
  };
  for (const r of findAll(nodes, (n) => (ts.isReturnStatement(n) && ownReturn(n) ? n : null))) {
    const e = r.expression ? unwrap(r.expression) : null;
    if (e && (e.kind === ts.SyntaxKind.TrueKeyword || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e))) {
      out.push(`answers ${brief(e)} before anything settled`);
    }
  }
  return out;
}

/**
 * room -> work in its handler outside the switch on the action, which runs
 * for every action, view ones included, and is answered by none.
 */
function workAroundSwitch(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const { sites } = effectModel(sf);
    for (const call of findAll([sf], (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useRoomActions' ? n : null))) {
      const handler = call.arguments[1] as ts.ArrowFunction;
      const body = ts.isBlock(handler.body) ? handler.body.statements : [handler.body];
      if (!body.some((st) => ts.isSwitchStatement(st))) continue;
      found[(call.arguments[0] as ts.StringLiteral).text] = sites(body.filter((st) => !ts.isSwitchStatement(st))).map((n) => n.getText().slice(0, 50));
    }
  }
  return found;
}

describe('a side-effecting room action is answered from its settled work (#1015)', () => {
  test('no side-effecting case says yes before its request has settled', () => {
    const code = handlerCode();
    const cases = Object.entries(code).flatMap(([room, actions]) =>
      Object.entries(actions).filter(([action]) => !isPresentationRoomAction(room, action)).map(([action, c]) => ({ room, action, nodes: c.nodes })));
    // Not vacuous: every side-effecting action in the table was read.
    const listed = Object.entries(ROOM_ACTIONS).flatMap(([room, a]) => Object.keys(a).filter((x) => !isPresentationRoomAction(room, x)));
    expect(cases.length).toBe(listed.length);
    expect(cases.length).toBeGreaterThan(30);
    const early = cases.flatMap(({ room, action, nodes }) => earlyAnswers(nodes).map((e) => `${room}/${action}: ${e}`));
    expect(early).toEqual([]);
    const around = workAroundSwitch();
    expect(Object.keys(around).length).toBeGreaterThanOrEqual(11);
    expect(Object.values(around).flat()).toEqual([]);
  });

  test('the detector sees an answer given early, and not one given late', () => {
    const sf = ts.createSourceFile('x.tsx', [
      'function Room() {',
      '  const data = useThingData();',
      '  const helper = async () => { await data.save(); };',
      '  useRoomActions("x", (action, args) => {',
      '    switch (action) {',
      '      case "a": { (async () => { await data.save(); })(); return true; }',
      '      case "b": { data.save(); return true; }',
      '      case "c": { return data.save().then((r) => r.ok); }',
      '      case "d": { helper(); return "Saved."; }',
      '      case "e": { const later = () => { return data.save(); }; later(); return false; }',
      '      case "f": { return (async () => { await data.save(); return true; })(); }',
      '      case "g": { if (!args.x) return false; setTimeout(() => data.save(), 0); return data.find(args.x).then(() => true); }',
      '      case "h": { if (!args.x) return false; return helper().then(() => `Saved ${args.x}.`); }',
      // Work dropped inside what is returned runs on after the answer.
      '      case "i": { return data.create().then((r) => { data.open(r.id); return true; }); }',
      '      case "j": { return (async () => { await data.create(); data.open(); return true; })(); }',
      '      case "k": { return data.create().then((r) => data.open(r.id)).then(() => true); }',
      '      case "l": { return (async () => { await data.create(); await data.open(); return true; })(); }',
      '      case "m": { return data.create().then(async (r) => { await data.open(r.id); return r.ok; }).catch(() => { data.undo(); return false; }); }',
      // Every link of a chain is looked into, an async function called where
      // it is written too, and a catch that hands back its own work is fine.
      '      case "n": { return data.create().then((r) => { data.open(); return r; }).then(() => true); }',
      '      case "o": { return (async () => { await (async () => { data.drop(); })(); return true; })(); }',
      '      case "p": { return data.create().then(() => true).catch(() => data.undo().then(() => false)); }',
      '      case "q": { return data.create().then(() => true).finally(() => { data.undo(); }); }',
      '    }',
      '  });',
      '}',
    ].join('\n'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const sw = findAll([sf], (n) => (ts.isSwitchStatement(n) ? n : null))[0]!;
    const found = Object.fromEntries(sw.caseBlock.clauses.map((c) => [(c as ts.CaseClause).expression.getText().replace(/"/g, ''), earlyAnswers(c.statements)]));
    expect(found).toEqual({
      a: ['work outside the answer: async () => { await data.save(); }', 'answers true before anything settled'],
      b: ['work outside the answer: data.save()', 'answers true before anything settled'],
      c: [],
      d: ['work outside the answer: helper()', 'answers "Saved." before anything settled'],
      e: ['work outside the answer: data.save()', 'work outside the answer: later()'],
      f: [],
      // data.find is a lookup, so only the dropped save is work.
      g: ['work outside the answer: data.save()'],
      h: [],
      i: ['work outside the answer: data.open(r.id)'],
      j: ['work outside the answer: data.open()'],
      k: [],
      l: [],
      m: ['work outside the answer: data.undo()'],
      n: ['work outside the answer: data.open()'],
      o: ['work outside the answer: data.drop()'],
      p: [],
      q: ['work outside the answer: data.undo()'],
    });
  });
});

describe('withRoomActionDefaults and pickRoomActionTarget (#1008)', () => {
  test('a left-out, mistyped or unknown argument becomes the handler\'s default; a good one stays', () => {
    expect(withRoomActionDefaults('settings', 'replay_onboarding', {})).toEqual({ scope: 'all' });
    expect(withRoomActionDefaults('settings', 'replay_onboarding', { scope: 'tutorials' })).toEqual({ scope: 'all' });
    expect(withRoomActionDefaults('settings', 'replay_onboarding', { scope: 5 })).toEqual({ scope: 'all' });
    expect(withRoomActionDefaults('settings', 'replay_onboarding', { scope: 'tutorial' })).toEqual({ scope: 'tutorial' });
    expect(withRoomActionDefaults('workspaces', 'create_project', { name: 'x' })).toEqual({ name: 'x', template: 'vite-react' });
    expect(withRoomActionDefaults('workspaces', 'create_project', { name: 'x', template: 'astro' })).toEqual({ name: 'x', template: 'astro' });
    expect(withRoomActionDefaults('goals', 'create_goal', { title: 't' })).toEqual({ title: 't', level: 'task' });
    expect(withRoomActionDefaults('tasks', 'reassign', { name: 'rent' })).toEqual({ name: 'rent', agent: null });
    expect(withRoomActionDefaults('tasks', 'reassign', { name: 'rent', agent: 'research' })).toEqual({ name: 'rent', agent: 'research' });
    // An action with no defaults, and a hostile name, are left alone.
    const args = { title: 'x' };
    expect(withRoomActionDefaults('tasks', 'create_task', args)).toBe(args);
    expect(withRoomActionDefaults('__proto__', 'toString', args)).toBe(args);
  });

  test('a pinned id is that item or none; else the name; only with no name, the selection', () => {
    const items = [{ id: 'a', name: 'alpha' }, { id: 'b', name: 'beta' }];
    const byName = (n: string) => items.find((i) => i.name.includes(n)) ?? null;
    const selected = items[1]!;
    expect(pickRoomActionTarget(items, { id: 'a', name: 'beta' }, byName, selected)).toBe(items[0]!);
    expect(pickRoomActionTarget(items, { id: 'gone', name: 'alpha' }, byName, selected)).toBeNull();
    expect(pickRoomActionTarget(items, { name: 'alp' }, byName, selected)).toBe(items[0]!);
    // A name that matches nothing is nothing, not the selection.
    expect(pickRoomActionTarget(items, { name: 'zeta' }, byName, selected)).toBeNull();
    expect(pickRoomActionTarget(items, {}, byName, selected)).toBe(selected);
    // A blank name is a name that matches nothing, as the rooms had it.
    expect(pickRoomActionTarget(items, { name: '  ' }, byName, selected)).toBeNull();
    expect(pickRoomActionTarget(items, {}, byName)).toBeNull();
  });

  test('the shared matchers match as the rooms did', () => {
    const projects = [{ name: 'jarvis-landing' }, { name: 'demo-app' }, { name: 'docs site' }];
    expect(matchProjectByName(projects, 'Jarvis Landing')).toBe(projects[0]!);
    expect(matchProjectByName(projects, 'landing')).toBe(projects[0]!);
    expect(matchProjectByName(projects, 'demo application')).toBe(projects[1]!);
    expect(matchProjectByName(projects, 'zzz')).toBeNull();
    expect(matchProjectByName(projects, ' ')).toBeNull();
    const tasks = [{ what: 'Pay rent to landlord' }, { what: 'rent' }];
    expect(matchByTitle(tasks, (t) => t.what, 'RENT')).toBe(tasks[1]!);
    expect(matchByTitle(tasks, (t) => t.what, 'landlord')).toBe(tasks[0]!);
    expect(matchByTitle(tasks, (t) => t.what, '')).toBeNull();
  });
});

describe('a remembered fact lands on the entity settled before its card (#1023)', () => {
  test('matchEntityByName: the exact name, else a whole-word part of one; two is ambiguous, none is null', () => {
    const es = [{ name: 'James' }, { name: 'Alice Smith' }, { name: 'Bob' }, { name: 'bob ' }, { name: 'Jos\u00e9 Garc\u00eda' }];
    expect(matchEntityByName(es, 'ALICE smith')).toEqual({ entity: es[1]! });
    expect(matchEntityByName(es, 'smith')).toEqual({ entity: es[1]! });
    expect(matchEntityByName(es, 'jos\u00e9')).toEqual({ entity: es[4]! });
    // "me" is inside "James" but is not a word of it.
    expect(matchEntityByName(es, 'me')).toBeNull();
    expect(matchEntityByName(es, 'ali')).toBeNull();
    expect(matchEntityByName(es, 'Bob')).toEqual({ ambiguous: 2 });
    expect(matchEntityByName(es, '  ')).toBeNull();
    expect(matchEntityByName(es, '--')).toBeNull();
    // An exact match wins over a longer name that holds it.
    expect(matchEntityByName([{ name: 'Alice' }, { name: 'Alice Smith' }], 'alice')).toEqual({ entity: { name: 'Alice' } });
    expect(matchEntityByName([{ name: 'Alice Jones' }, { name: 'Alice Smith' }], 'alice')).toEqual({ ambiguous: 2 });
    // A name typed with a combining accent is the one stored precomposed.
    expect(matchEntityByName(es, 'Jose\u0301 Garci\u0301a')).toEqual({ entity: es[4]! });
    expect(matchEntityByName(es, 'jose\u0301')).toEqual({ entity: es[4]! });
  });

  test('withoutEntityPin drops the pin from an entity action only', () => {
    expect(withoutEntityPin('memory', 'remember_that', { subject: 's', id: 'e', new_entity: true })).toEqual({ subject: 's' });
    const args = { name: 'rent', id: 't1' };
    expect(withoutEntityPin('tasks', 'complete_task', args)).toBe(args);
    expect(withoutEntityPin('__proto__', 'toString', args)).toBe(args);
  });

  test('every entity action is a side-effecting room action whose case reads the pinned entity', () => {
    const entries = tableEntries(ROOM_ACTION_ENTITY_TARGETS);
    expect(entries).toEqual(['memory/remember_that']);
    for (const entry of entries) {
      const [room, action] = entry.split('/') as [string, string];
      expect([entry, isPresentationRoomAction(room, action), isRoomAction(room, action)]).toEqual([entry, false, true]);
      const arg = roomActionEntityArg(room, action)!;
      // The case reads the name, the id it is pinned by, and the new-entity mark.
      expect(Object.keys(ROOM_ACTION_ARGS[room]![action]!)).toEqual(expect.arrayContaining([arg, 'id', 'new_entity']));
      const { nodes, args } = handlerCode()[room]![action]!;
      expect(argReads(nodes, args)).toEqual(expect.arrayContaining([arg, 'id', 'new_entity']));
    }
    expect(roomActionEntityArg('memory', 'select')).toBeNull();
    expect(roomActionEntityArg('__proto__', 'toString')).toBeNull();
    expect(roomActionEntityArg('memory', 'constructor')).toBeNull();
  });
});

describe('a room action takes the time the daemon settled, and reads no words as one (#1022)', () => {
  test('the actions that take a settled time are exactly those in ROOM_ACTION_TIMES, and each case reads it and its words', () => {
    const entries = tableEntries(ROOM_ACTION_TIMES);
    expect(entries).toEqual(['calendar/schedule_event', 'content/schedule', 'tasks/create_task']);
    const takesSettled = Object.entries(ROOM_ACTION_ARGS).flatMap(([room, actions]) =>
      Object.entries(actions).filter(([, args]) => Object.prototype.hasOwnProperty.call(args, SETTLED_TIME_ARG)).map(([action]) => `${room}/${action}`)).sort();
    expect(takesSettled).toEqual(entries);
    const code = handlerCode();
    for (const entry of entries) {
      const [room, action] = entry.split('/') as [string, string];
      expect([entry, isPresentationRoomAction(room, action), isRoomAction(room, action)]).toEqual([entry, false, true]);
      const { arg } = roomActionTimeArg(room, action)!;
      expect(ROOM_ACTION_ARGS[room]![action]![SETTLED_TIME_ARG]).toEqual(['number']);
      expect(ROOM_ACTION_ARGS[room]![action]![arg]).toEqual(['string']);
      const { nodes, args } = code[room]![action]!;
      expect([entry, argReads(nodes, args)]).toEqual([entry, expect.arrayContaining([arg, SETTLED_TIME_ARG])]);
    }
    expect(roomActionTimeArg('tasks', 'complete_task')).toBeNull();
    expect(roomActionTimeArg('__proto__', 'toString')).toBeNull();
    expect(roomActionTimeArg('tasks', 'constructor')).toBeNull();
  });

  test('no room handler parses a time itself', () => {
    const parsing: string[] = [];
    for (const [room, actions] of Object.entries(handlerCode())) {
      for (const [action, { nodes }] of Object.entries(actions)) {
        if (nodes.some((n) => /\bparseRelativeDate\s*\(/.test(n.getText()))) parsing.push(`${room}/${action}`);
      }
    }
    expect(parsing).toEqual([]);
  });
});

