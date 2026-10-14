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
