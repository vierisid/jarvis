import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { applyExpressionPatch, expressionPatches } from './activepieces-expression-patch';

test('vendor expression patches round-trip the checked-in engine files and reject drift', () => {
  for (const [path, replacements] of Object.entries(expressionPatches)) {
    const checkedIn = readFileSync(new URL(`../src/workflows/activepieces/${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    let upstream = checkedIn;
    for (const [before, after] of [...replacements].reverse()) {
      expect(upstream.split(after)).toHaveLength(2);
      upstream = upstream.replace(after, () => before);
    }
    expect(applyExpressionPatch(upstream, replacements)).toBe(checkedIn);
    expect(() => applyExpressionPatch(upstream + upstream, replacements)).toThrow('exactly once');
    expect(() => applyExpressionPatch('', replacements)).toThrow('exactly once');
  }
});
