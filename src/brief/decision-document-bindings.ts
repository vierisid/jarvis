import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** Optional Q-05 owner seam, loaded once at boot from a fixed local module.
 * Never reuse the original recipient's facts for a newly edited address. */
export interface DocumentFactBindings { available: boolean; capture(args: Record<string, unknown>, previous?: unknown[]): unknown[] }
export async function loadDocumentFactBindings(): Promise<DocumentFactBindings | undefined> {
  const path = new URL('../workflows/runtime/fact-bindings.ts', import.meta.url);
  if (!existsSync(fileURLToPath(path))) return undefined;
  try {
    const owner = await import(path.href);
    if (typeof owner.recipientAddresses !== 'function' || typeof owner.recipientFactPins !== 'function' || typeof owner.assertRecipientFactsCurrent !== 'function') throw Error('Unsupported fact bindings');
    return { available: true, capture(args, previous = []) {
      const addresses: string[] = owner.recipientAddresses(args);
      const fresh = owner.recipientFactPins(addresses) as Array<{ value: string; factIds: string[] }>;
      const prior = previous as Array<{ value: string; factIds: string[] }>;
      // Retain the original identity for unchanged recipients, including deleted
      // facts. Re-querying a deleted fact would return nothing and bypass Q-05.
      const retained = prior.filter(pin => addresses.some(address => address.toLowerCase() === pin.value.toLowerCase()));
      const pins = [...retained, ...fresh.filter(pin => !retained.some(old => old.value.toLowerCase() === pin.value.toLowerCase()))];
      owner.assertRecipientFactsCurrent(pins); return pins;
    } };
  } catch { return { available: false, capture() { throw Error('Recipient fact bindings are unavailable'); } }; }
}
