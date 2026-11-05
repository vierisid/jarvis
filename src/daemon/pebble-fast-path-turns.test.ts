import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { makeFastPathTurns } from './pebble-dialogue.ts';

// #1157: fast-path turns answer without the LLM and were never stored, so
// "do that again" resolved to the LLM turn before them.
test('a fast-path turn is stored with everything it spoke, once, and a silent one is not', () => {
  const stored: Array<[string, string]> = [];
  const turns = makeFastPathTurns((u, r) => { stored.push([u, r]); return true; });
  const a = {}, b = {}, silent = {};
  turns.spoke(a, 'Opening Tasks.'); turns.spoke(b, 'Closed Settings.'); turns.spoke(a, 'Here it is.');
  expect(turns.finish(a, 'open tasks')).toBe(true);
  expect(turns.finish(a, 'open tasks')).toBe(false);
  expect(turns.finish(silent, 'hm')).toBe(false);
  expect(turns.finish(b, 'close settings')).toBe(true);
  expect(stored).toEqual([['open tasks', 'Opening Tasks. Here it is.'], ['close settings', 'Closed Settings.']]);
});

test('every fast path stores what it spoke, the region refusal included (a started capture re-enters the LLM path)', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const start = index.indexOf('// Fast paths (skip the LLM entirely).');
  const end = index.indexOf("await setState(sidecarId, 'thinking', '');", start);
  expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
  const dispatch = index.slice(start, end);
  expect(dispatch).toContain('tryHandlePanelIntent');
  for (const path of ['settings-intent', 'in-panel-action', 'sub-pebble-close', 'background-intent', 'panel-intent']) {
    expect(dispatch).toContain(`pebbleFastPathTurns.finish(ctrl, opts?.historyText ?? userText);\n          console.log(\`[ambient-ui] ${path} fast path`);
  }
  expect(dispatch).toMatch(/tryHandleRegionIntent\(sidecarId, userText, ctrl\)\) \{\n[^\n]*\n\s*pebbleFastPathTurns\.finish\(ctrl, opts\?\.historyText \?\? userText\);/);
  expect(dispatch.match(/pebbleFastPathTurns\.finish/g)).toHaveLength(6);
  expect(index).toContain('spoken: (ctrl, text) => pebbleFastPathTurns.spoke(ctrl, text),');
});

test('a full Pebble reply is mirrored to the dashboard only, never to Telegram or Discord (owner decision, #1157)', () => {
  const index = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const from = index.indexOf("await setState(sidecarId, 'speaking', fullText);"), to = index.indexOf('// Long-answer overflow');
  expect(from).toBeGreaterThan(-1); expect(to).toBeGreaterThan(from);
  const reply = index.slice(from, to);
  expect(reply).toContain('wsService.broadcastHeartbeatToDashboard(fullText)');
  expect(reply).not.toMatch(/wsService\.broadcastHeartbeat\(/);
});
