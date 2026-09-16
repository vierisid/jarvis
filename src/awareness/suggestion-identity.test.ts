import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, getDb, initDatabase } from '../vault/schema.ts';
import { getRecentSuggestions, markSuggestionDismissed } from '../vault/awareness.ts';
import { canonicalSuggestion } from './suggestion-feedback.ts';
import { automationIdentity } from '../vault/suggestion-schema.ts';

let directory: string | undefined;
afterEach(() => { closeDb(); if (directory) rmSync(directory, { recursive: true, force: true }); });

/** Write a pre-C6 app-pair row the way the removed heuristic did: straight into
 *  awareness_suggestions with no identity row. Going through createSuggestion
 *  would mint the identity and skip the upgrade path this test exists for. */
function legacyAppPair(id: string, fromApp: string, toApp: string, count: number, createdAt: number) {
  getDb().run(`INSERT INTO awareness_suggestions
    (id, type, trigger_capture_id, title, body, context, delivered, delivered_at, delivery_channel, dismissed, acted_on, created_at)
    VALUES (?, 'automation', NULL, ?, ?, ?, 0, NULL, NULL, 0, 0, ?)`,
    [id, `Repetitive pattern: ${fromApp} <-> ${toApp}`,
      `You switched between ${fromApp} and ${toApp} ${count} times recently.`,
      JSON.stringify({ pattern: 'app_switch', fromApp, toApp, count }), createdAt]);
}

// The live app-pair producer is gone, so this can no longer be driven through
// SuggestionEngine without passing vacuously -- asserting the engine emits
// nothing would prove nothing. What still reaches the app-pair identity is
// ensureSuggestionSchema's backfill over rows an upgrading user already has.
test('an upgrade gives pre-existing app-pair rows one stable identity across restart', () => {
  directory = mkdtempSync(join(tmpdir(), 'jarvis-identity-'));
  const path = join(directory, 'test.db');
  initDatabase(path, { quiet: true });
  const base = Date.now() - 86_400_000;
  // Same pair, opposite order, different counts: one routine, three rows.
  legacyAppPair('legacy-1', 'Mail', 'Sheets', 3, base);
  legacyAppPair('legacy-2', 'Sheets', 'Mail', 7, base + 1000);
  legacyAppPair('legacy-3', 'mail', 'sheets', 11, base + 2000);
  getDb().run('DELETE FROM suggestion_identities');

  // Reopen: the backfill is what assigns identity to rows that never had one.
  closeDb(); initDatabase(path, { quiet: true });
  const keys = getDb().query<{ pattern_key: string }, []>(
    'SELECT DISTINCT pattern_key FROM suggestion_identities').all();
  expect(keys).toHaveLength(1);
  expect(keys[0]!.pattern_key).toBe(automationIdentity({ type: 'automation', title: '', body: '',
    context: { pattern: 'app_switch', fromApp: 'Mail', toApp: 'Sheets' } })!);
  expect(keys[0]!.pattern_key.startsWith('app-pair-v1:')).toBe(true);
  // Order and count must not split the family. Without the app-pair branch the
  // title/body hash fallback gives each historical row its own identity, and a
  // dismissal recorded against one stops carrying to the others.
  expect(canonicalSuggestion('legacy-3').id).toBe('legacy-1');

  markSuggestionDismissed('legacy-2');
  closeDb(); initDatabase(path, { quiet: true });
  for (const id of ['legacy-1', 'legacy-2', 'legacy-3']) {
    expect(canonicalSuggestion(id)).toMatchObject({ id: 'legacy-1', dismissed: 1 });
  }
  expect(getRecentSuggestions(100, 'automation')).toHaveLength(3);
});
