import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { createSuggestion, getRecentSuggestions, markSuggestionDismissed } from '../vault/awareness.ts';
import { SuggestionEngine } from './suggestion-engine.ts';
import type { ScreenContext, Suggestion } from './types.ts';

let directory: string | undefined;
afterEach(() => { closeDb(); if (directory) rmSync(directory, { recursive: true, force: true }); });

test('a dismissed app-pair proposal does not return after restarting the engine and database', async () => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-identity-'));
  const path = join(directory, 'test.db'); initDatabase(path);
  async function observe(engine: SuggestionEngine, reversed: boolean) {
    const suggestions: Suggestion[] = [];
    for (let index = 0; index < 10; index++) {
      const context: ScreenContext = { captureId: `cap-${index}`, timestamp: Date.now(),
        appName: (index % 2 === 0) !== reversed ? 'Mail' : 'Sheets', windowTitle: 'Work',
        url: null, filePath: null, ocrText: '', sessionId: 'session', isSignificantChange: true, isAppSwitch: true };
      const suggestion = await engine.evaluate(context, [{ type: 'context_changed', data: {}, timestamp: Date.now() }]);
      if (suggestion) suggestions.push(suggestion);
    }
    return suggestions;
  }
  // Seed a real legacy proposal so the regression also applies after C6 stops
  // generating app-only suggestions. Existing feedback must still survive.
  const before = createSuggestion({ type: 'automation', title: 'Repetitive pattern: Mail ↔ Sheets',
    body: 'Switched between Mail and Sheets 3 times.',
    context: { pattern: 'app_switch', fromApp: 'Mail', toApp: 'Sheets', count: 3 } });
  markSuggestionDismissed(before.id);
  closeDb(); initDatabase(path);
  const after = await observe(new SuggestionEngine(0), true);
  expect(after).toHaveLength(0);
  expect(getRecentSuggestions(100, 'automation')).toHaveLength(1);
});
