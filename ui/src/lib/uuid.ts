/**
 * UUID v4 that works in non-secure contexts.
 *
 * crypto.randomUUID is gated behind secure contexts (HTTPS or localhost), so
 * on a dashboard served over plain HTTP from a LAN IP it simply doesn't exist
 * and calling it throws (issue #260). crypto.getRandomValues has no such
 * gate, so fall back to building the v4 by hand from it.
 */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidV4FromRandomValues();
}

/** Fallback path, exported for direct testing (randomUUID exists under bun). */
export function uuidV4FromRandomValues(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
