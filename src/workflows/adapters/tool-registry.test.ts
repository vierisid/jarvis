import { describe, test, expect } from 'bun:test';
import { JarvisToolRegistryAdapter } from './tool-registry';
import { ToolRegistry, type ToolDefinition } from '../../actions/tools/registry';
import { withTrustedTrailer, UNTRUSTED_OPEN } from '../../roles/untrusted.ts';

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

  test('an undefined return passes through as undefined; the BOUNDARY normalises it', async () => {
    // The adapter changes nothing, which is the contract this file pins. It is
    // the effect boundary, not this adapter, that turns a missing result into a
    // receipt value (`record.result = result ?? null` in runtime/
    // effect-boundary.ts) -- so a resumed run replays `null`, not `undefined`.
    expect(await adapterFor(async () => undefined).execute('t', {})).toBe(undefined);
  });

  test('a trusted-trailer carrier is unwrapped, so no class instance reaches JSON', async () => {
    // The one case this adapter must change: a carrier would serialise to
    // `{"untrusted":...,"trustedTrailer":...}` for the workflow sandbox.
    //
    // The trailer is DROPPED, not concatenated (#573). It is repo-authored
    // instructions to a model, and a workflow step's result is data: a
    // `browser_snapshot` -> `write_file` flow would otherwise write the playbook
    // into the file. Concatenating also puts page text directly against
    // repo-authored instructions with no boundary, which is the #529 shape.
    const out = await adapterFor(async () => withTrustedTrailer('Page: x', '\n\nplaybook')).execute('t', {});
    expect(out).toBe('Page: x');
  });

  /**
   * Dropping must not become "tidying", and nothing on this path frames, defangs
   * or rewrites. Both cases below use delimiter-shaped bytes built from the real
   * constant, so if `UNTRUSTED_OPEN` ever changes these keep testing what they
   * claim to instead of degrading into "arbitrary text survives".
   */
  const delimiterShaped = `line1\n${UNTRUSTED_OPEN} deadbeef source="x"\nline2\n\t trailing `;

  test('the payload is passed through byte-exact when the trailer is dropped', async () => {
    const out = await adapterFor(async () => withTrustedTrailer(delimiterShaped, '\n\nplaybook')).execute('t', {});
    expect(out).toBe(delimiterShaped);
  });

  test('a plain string return carrying delimiter-shaped bytes is not defanged either', async () => {
    // The realistic case: `read_file` returning a file that happens to contain
    // the marker. The chat path would defang or frame; here the bytes are the
    // step's data and must arrive exactly as the file held them.
    const out = await adapterFor(async () => delimiterShaped).execute('t', {});
    expect(out).toBe(delimiterShaped);
  });
});
