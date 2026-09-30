import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SIDECAR_LATEST_VERSION, parseSemver } from './compat.ts';

// The brain advertises SIDECAR_LATEST_VERSION to every connecting sidecar as
// the version to update to. It has to be the sidecar released alongside this
// brain, and release-exec publishes exactly sidecar/VERSION, so the two must
// never drift: a sidecar bump that forgets compat.ts would leave every brain
// of that release offering the previous sidecar, and one that bumps compat.ts
// alone would offer a version nobody published.
describe('SIDECAR_LATEST_VERSION', () => {
  test('equals sidecar/VERSION', () => {
    const file = readFileSync(new URL('../../sidecar/VERSION', import.meta.url), 'utf8').trim();
    expect(SIDECAR_LATEST_VERSION).toBe(file);
  });
  test('is a canonical version', () => {
    expect(parseSemver(SIDECAR_LATEST_VERSION)).not.toBeNull();
  });
});
