import { assertRecipientFactsCurrent, recipientAddresses, recipientFactPins, type FactPin } from '../workflows/runtime/fact-bindings';
/** Q-05 recipient facts for a revised document. Never reuse the original
 * recipient's facts for a newly edited address. */
export interface DocumentFactBindings { available: boolean; capture(args: Record<string, unknown>, previous?: unknown[]): unknown[] }
export function documentFactBindings(): DocumentFactBindings {
  return { available: true, capture(args, previous = []) {
    const addresses = recipientAddresses(args);
    const fresh = recipientFactPins(addresses);
    const prior = previous as FactPin[];
    // Retain the original identity for unchanged recipients, including deleted
    // facts. Re-querying a deleted fact would return nothing and bypass Q-05.
    const retained = prior.filter(pin => addresses.some(address => address.toLowerCase() === pin.value.toLowerCase()));
    const pins = [...retained, ...fresh.filter(pin => !retained.some(old => old.value.toLowerCase() === pin.value.toLowerCase()))];
    assertRecipientFactsCurrent(pins); return pins;
  } };
}
