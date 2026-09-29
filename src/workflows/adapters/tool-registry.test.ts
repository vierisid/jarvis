import { describe, test, expect } from 'bun:test';
import { JarvisToolRegistryAdapter } from './tool-registry';
import { ToolRegistry, type ToolDefinition } from '../../actions/tools/registry';
import { withTrustedTrailer } from '../../roles/untrusted.ts';

function adapterFor(execute: ToolDefinition['execute']): JarvisToolRegistryAdapter {
  const registry = new ToolRegistry();
  registry.register({ name: 't', description: 'd', category: 'general', parameters: {}, execute });
  return new JarvisToolRegistryAdapter(registry);
}

/**
 * This adapter's return value becomes a durable EFFECT RECEIPT: service-backends
 * hands it to `effects.invoke`, and a resumed workflow replays that receipt
 * instead of acting again. So the shape of a tool's return has to survive the
 * adapter exactly.
 *
 * #560 briefly broke this by collapsing every return to text here (to stop an
 * untrusted-content carrier reaching JSON serialisation), which turned an object
 * receipt into a JSON string of itself and changed replay semantics.
 * `cancellation-authority.integration.test.ts` caught it end to end; these pin
 * the unit so the next change does not have to be caught by an integration test.
 */
describe('JarvisToolRegistryAdapter preserves the tool return shape', () => {
  test('an object return passes through as the same object, not JSON', async () => {
    const receipt = { remoteId: 'committed-receipt', nested: { n: 1 } };
    const out = await adapterFor(async () => receipt).execute('t', {});
    expect(out).toEqual(receipt);
    expect(typeof out).toBe('object');
  });

  test('primitive and array returns keep their types', async () => {
    expect(await adapterFor(async () => 'plain text').execute('t', {})).toBe('plain text');
    expect(await adapterFor(async () => 42).execute('t', {})).toBe(42);
    expect(await adapterFor(async () => true).execute('t', {})).toBe(true);
    expect(await adapterFor(async () => null).execute('t', {})).toBe(null);
    expect(await adapterFor(async () => [1, { a: 2 }]).execute('t', {})).toEqual([1, { a: 2 }]);
  });

  test('a trusted-trailer carrier IS collapsed, so no class instance reaches JSON', async () => {
    // The one case this adapter must change: a carrier would serialise to
    // `{"untrusted":...,"trustedTrailer":...}` for the workflow sandbox.
    const out = await adapterFor(async () => withTrustedTrailer('Page: x', '\n\nplaybook')).execute('t', {});
    expect(out).toBe('Page: x\n\nplaybook');
  });
});
