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
import { isRoomAction, ROOM_ACTIONS } from './room-actions.ts';

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
    const fromTable = Object.fromEntries(Object.entries(ROOM_ACTIONS).map(([r, a]) => [r, [...a].sort()]));
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
