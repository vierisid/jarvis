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
  collapseRoomActionAliases, matchByTitle, matchProjectByName, pickRoomActionTarget, ROOM_ACTION_ALIASES, ROOM_ACTION_DEFAULTS,
  ROOM_ACTION_TARGETS, withRoomActionDefaults,
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
const PURE_HOOK_CALL = /^(find\w*|refresh|toggleSource|setTimeWindow|setLiveTail)$/;

function handlerEffects(): Record<string, Record<string, boolean>> {
  const found: Record<string, Record<string, boolean>> = {};
  for (const file of sourceFiles(ROOMS_DIR)) {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('useRoomActions(')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
    const effectful = (nodes: readonly ts.Node[], seen = new Set<string>()): boolean => {
      let hit = false;
      const walk = (n: ts.Node): void => {
        if (hit) return;
        if (ts.isAwaitExpression(n) || isAsyncFn(n)) { hit = true; return; }
        if (ts.isCallExpression(n)) {
          const callee = n.expression;
          if (ts.isIdentifier(callee)) {
            const name = callee.text;
            if (name === 'fetch' || (hookMethods.has(name) && !PURE_HOOK_CALL.test(name))) { hit = true; return; }
            const helper = helpers.get(name);
            if (helper && !seen.has(name)) {
              seen.add(name);
              if (effectful([helper], seen)) { hit = true; return; }
            }
          }
          if (ts.isPropertyAccessExpression(callee)) {
            if (callee.name.text === 'then') { hit = true; return; }
            if (ts.isIdentifier(callee.expression) && hookObjects.has(callee.expression.text)
              && !PURE_HOOK_CALL.test(callee.name.text)) { hit = true; return; }
          }
        }
        ts.forEachChild(n, walk);
      };
      nodes.forEach(walk);
      return hit;
    };
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
 * Where a case lets one argument stand in for another: `args.a ?? args.b`,
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
