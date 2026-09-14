import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { createCapture, getRecentSuggestions, markSuggestionDelivered } from '../vault/awareness.ts';
import { refreshOpportunity } from './opportunities.ts';

test.each(['pending', 'legacy'])('a fresh service recovers a %s proposal without captures or workflow events', async state => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-opportunity-delivery-'));
  const dbPath = join(dir, 'vault.db');
  try {
    initDatabase(dbPath, { quiet: true });
    for (let days = 1; days <= 3; days++) {
      createCapture({ timestamp: Date.now() - days * 86_400_000, pixelChangePct: 0.5,
        appName: 'Accounting', windowTitle: 'Overdue invoices' });
    }
    const item = refreshOpportunity()!;
    expect(getRecentSuggestions()[0]!.delivered).toBe(0);
    if (state === 'legacy') {
      markSuggestionDelivered(item.id, 'websocket');
      getDb().run('DROP TABLE IF EXISTS opportunity_delivery');
    }
    // End the producing process's DB lifetime before any callback is invoked.
    closeDb();
    const script = `
      import { initDatabase, closeDb } from ${JSON.stringify(new URL('../vault/schema.ts', import.meta.url).href)};
      import { getRecentSuggestions } from ${JSON.stringify(new URL('../vault/awareness.ts', import.meta.url).href)};
      import { AwarenessService } from ${JSON.stringify(new URL('./service.ts', import.meta.url).href)};
      initDatabase(${JSON.stringify(dbPath)}, { quiet: true });
      const deliveries = [], events = [];
      const service = new AwarenessService({ awareness: { enabled: true, capture_interval_ms: 15000,
        cloud_vision_enabled: false, retention: { full_hours: 24, key_moment_hours: 72 } } }, {},
        event => events.push(event), null, undefined, undefined,
        async suggestion => { deliveries.push(suggestion.id); return 'websocket'; });
      await service.start();
      await new Promise(resolve => setTimeout(resolve, 100));
      await service.stop();
      const rows = getRecentSuggestions();
      closeDb();
      console.log('RESULT:' + JSON.stringify({ deliveries, events, rows: rows.length, delivered: rows[0].delivered }));
    `;
    const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' });
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, errors }).toEqual({ code: 0, errors: '' });
    const result = JSON.parse(output.split('RESULT:')[1]!);
    expect(result).toEqual({ deliveries: [item.id], events: [], rows: 1, delivered: 1 });
  } finally { closeDb(); rmSync(dir, { recursive: true, force: true }); }
});
