import { expect, test } from 'bun:test';
import { initDatabase } from '../vault/schema.ts';
import { SuggestionEngine } from './suggestion-engine.ts';
import type { ScreenContext } from './types.ts';

test('ordinary app switching cannot substantiate a recurring business job', async () => {
  initDatabase(':memory:');
  const engine = new SuggestionEngine(0);
  const suggestions = [];
  for (let i = 0; i < 8; i++) {
    const context: ScreenContext = {
      captureId: `capture-${i}`, timestamp: Date.now() - (8 - i) * 1000,
      appName: i % 2 ? 'Browser' : 'Spreadsheet', windowTitle: 'Untitled',
      ocrText: '', sessionId: 'session', url: null, filePath: null,
      isSignificantChange: true, isAppSwitch: true,
    };
    suggestions.push(await engine.evaluate(context, [{ type: 'context_changed', data: {
      fromApp: i % 2 ? 'Spreadsheet' : 'Browser', toApp: context.appName,
      fromWindow: 'Untitled', toWindow: 'Untitled',
    }, timestamp: context.timestamp }]));
  }
  expect(suggestions.filter(s => s?.type === 'automation')).toEqual([]);
});
