/**
 * AES-256-GCM at-rest encryption for `app_connection.value`.
 *
 * Tests cover:
 *   - encrypt -> decrypt round-trip preserves the value
 *   - ciphertext changes per call (IV is fresh)
 *   - tampered ciphertext fails decryption (auth tag catches it)
 *   - wrong key fails decryption
 *   - legacy plaintext JSON passes through `decryptJson` unchanged
 *   - parse failures before and after decryption never quote the value
 *   - an `enc1a:` blob only authenticates under the row identity it was
 *     sealed for, per identity field
 *   - all three stored shapes (plaintext / `enc1:` / `enc1a:`) read correctly
 *   - strict mode refuses plaintext only, and never quotes it
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  decryptBoundJson,
  decryptJson,
  encryptBoundJson,
  encryptJson,
  ENCRYPTED_VALUE_SQL,
  isEncrypted,
  isRowBound,
  requireEncryptedCredentials,
  setEncryptionKey,
  setRequireEncryptedCredentials,
  withLegacyPlaintextReads,
  type CredentialRowBinding,
} from "./encryption";

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

const ROW_A: CredentialRowBinding = {
  id: "conn_fixture_a",
  projectId: "jrv_proj_default",
  pieceName: "fixture-low-privilege",
  externalId: "fixture-external-a",
};
const ROW_B: CredentialRowBinding = {
  id: "conn_fixture_b",
  projectId: "jrv_proj_default",
  pieceName: "fixture-high-privilege",
  externalId: "fixture-external-b",
};

/**
 * The message `JSON.parse` produces for `input`. The leak tests below use it to
 * pin that their sentinel really is one the parser quotes back: Bun echoes a
 * bare identifier verbatim but truncates most other malformed input to its
 * first token, so a sentinel chosen carelessly would satisfy `not.toContain`
 * even if `decryptJson` started appending the parser message again.
 */
function parserMessageFor(input: string): string {
  try {
    JSON.parse(input);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("sentinel must not be valid JSON");
}

beforeEach(() => setEncryptionKey(KEY_A));
afterEach(() => {
  setEncryptionKey(null);
  setRequireEncryptedCredentials(false);
});

describe("encryption", () => {
  test("encrypt -> decrypt round-trips OAuth-shaped values", () => {
    const value = {
      access_token: "ya29.fake",
      refresh_token: "rt_xyz",
      expiry_date: 1_700_000_000,
      scope: "gmail.readonly",
    };
    const blob = encryptJson(value);
    expect(isEncrypted(blob)).toBe(true);
    expect(blob).toMatch(/^enc1:/);
    expect(decryptJson(blob)).toEqual(value);
  });

  test("ciphertext changes per call (fresh IV)", () => {
    const value = { token: "x" };
    const a = encryptJson(value);
    const b = encryptJson(value);
    expect(a).not.toBe(b);
  });

  test("tampered ciphertext fails decryption", () => {
    const blob = encryptJson({ secret: "abc" });
    // Flip the last byte of the base64 payload.
    const tampered =
      blob.slice(0, -1) + (blob.slice(-1) === "A" ? "B" : "A");
    expect(() => decryptJson(tampered)).toThrow();
  });

  test("decrypting with the wrong key throws", () => {
    const blob = encryptJson({ secret: "abc" });
    setEncryptionKey(KEY_B);
    expect(() => decryptJson(blob)).toThrow();
  });

  test("legacy plaintext JSON passes through unchanged", () => {
    const legacy = JSON.stringify({ access_token: "old", refresh_token: "old" });
    expect(isEncrypted(legacy)).toBe(false);
    expect(decryptJson(legacy)).toEqual({ access_token: "old", refresh_token: "old" });
  });

  test("malformed encrypted blob throws", () => {
    expect(() => decryptJson("enc1:notbase64")).toThrow();
    expect(() => decryptJson("enc1:")).toThrow();
  });

  test("malformed legacy JSON errors never include credential text", () => {
    const secret = "syntheticMalformedLegacyCredentialToken";
    expect(parserMessageFor(secret)).toContain(secret);
    let message = "";
    try { decryptJson(secret); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("legacy plaintext is not valid JSON");
    expect(message).not.toContain(secret);
  });

  test("authenticated but invalid JSON errors never include decrypted credential text", () => {
    const secret = "syntheticInvalidDecryptedCredentialToken";
    expect(parserMessageFor(secret)).toContain(secret);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", KEY_A, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const stored = "enc1:" + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    let message = "";
    try { decryptJson(stored); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("decrypted bytes are not valid JSON");
    expect(message).not.toContain(secret);
  });
});

describe("row-bound credential envelope", () => {
  test("bound encrypt -> decrypt round-trips under the same row identity", () => {
    const value = { access_token: "syntheticBoundRoundTripToken", expiry_date: 1_700_000_000 };
    const blob = encryptBoundJson(value, ROW_A);
    expect(blob).toMatch(/^enc1a:/);
    expect(isEncrypted(blob)).toBe(true);
    expect(isRowBound(blob)).toBe(true);
    expect(decryptBoundJson(blob, ROW_A)).toEqual(value);
  });

  test("a bound blob does not carry the plaintext and gets a fresh IV per call", () => {
    const token = "syntheticBoundCiphertextInspectionToken";
    const first = encryptBoundJson({ access_token: token }, ROW_A);
    const second = encryptBoundJson({ access_token: token }, ROW_A);
    expect(first).not.toContain(token);
    expect(first).not.toBe(second);
    const bytes = (blob: string) => Buffer.from(blob.slice("enc1a:".length), "base64");
    // The IV is the first 12 bytes; distinct IVs are what makes the blobs differ.
    expect(bytes(first).subarray(0, 12).equals(bytes(second).subarray(0, 12))).toBe(false);
  });

  test("row A's ciphertext does not authenticate as row B", () => {
    const token = "syntheticHighPrivilegeRowAToken";
    const stolen = encryptBoundJson({ access_token: token }, ROW_A);
    // This is the #481 row swap: the attacker has no key, only write access.
    let message = "";
    try {
      decryptBoundJson(stolen, ROW_B, "app_connection conn_fixture_b");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("auth verification failed");
    expect(message).not.toContain(token);
    // ... and it is not that the blob is simply unreadable: its own row opens it.
    expect(decryptBoundJson(stolen, ROW_A)).toEqual({ access_token: token });
  });

  test.each([
    ["id", { id: "conn_fixture_moved" }],
    ["projectId", { projectId: "jrv_proj_other" }],
    ["pieceName", { pieceName: "fixture-high-privilege" }],
    ["externalId", { externalId: "fixture-external-relabelled" }],
  ] as const)("changing %s alone breaks authentication", (_field, override) => {
    const blob = encryptBoundJson({ access_token: "syntheticSingleFieldRebindToken" }, ROW_A);
    expect(() => decryptBoundJson(blob, { ...ROW_A, ...override })).toThrow(/auth verification failed/);
  });

  test("the unbound reader refuses a bound blob instead of reporting a key problem", () => {
    const blob = encryptBoundJson({ access_token: "syntheticUnboundReaderToken" }, ROW_A);
    expect(() => decryptJson(blob)).toThrow(/requires its row identity/);
  });

  test("the bound reader accepts all three stored shapes", () => {
    const plaintext = JSON.stringify({ access_token: "syntheticMixedPlaintextToken" });
    const unbound = encryptJson({ access_token: "syntheticMixedUnboundToken" });
    const bound = encryptBoundJson({ access_token: "syntheticMixedBoundToken" }, ROW_A);
    expect(decryptBoundJson(plaintext, ROW_A)).toEqual({ access_token: "syntheticMixedPlaintextToken" });
    // An unbound blob has no associated data whatever row it now sits in, so
    // it still reads during the conversion window -- including under ROW_B.
    expect(decryptBoundJson(unbound, ROW_A)).toEqual({ access_token: "syntheticMixedUnboundToken" });
    expect(decryptBoundJson(unbound, ROW_B)).toEqual({ access_token: "syntheticMixedUnboundToken" });
    expect(decryptBoundJson(bound, ROW_A)).toEqual({ access_token: "syntheticMixedBoundToken" });
  });

  test("the envelope predicates and SQL cover both prefixes", () => {
    const unbound = encryptJson({ token: "x" });
    const bound = encryptBoundJson({ token: "x" }, ROW_A);
    expect([isEncrypted(unbound), isEncrypted(bound), isEncrypted("{}")]).toEqual([true, true, false]);
    expect([isRowBound(unbound), isRowBound(bound)]).toEqual([false, true]);
    // A missing-key check written as `value LIKE 'enc1:%'` would miss enc1a:
    // rows entirely, so the shared predicate has to name both.
    expect(ENCRYPTED_VALUE_SQL).toContain("'enc1:%'");
    expect(ENCRYPTED_VALUE_SQL).toContain("'enc1a:%'");
  });

  test("a wrong key still fails a bound blob", () => {
    const blob = encryptBoundJson({ access_token: "syntheticWrongKeyBoundToken" }, ROW_A);
    setEncryptionKey(KEY_B);
    expect(() => decryptBoundJson(blob, ROW_A)).toThrow();
  });
});

describe("strict credential encryption", () => {
  test("defaults off so legacy plaintext rows keep reading", () => {
    expect(requireEncryptedCredentials()).toBe(false);
    const legacy = JSON.stringify({ access_token: "syntheticDefaultLenientToken" });
    expect(decryptJson(legacy)).toEqual({ access_token: "syntheticDefaultLenientToken" });
  });

  test("refuses plaintext without quoting it, through both readers", () => {
    const secret = "syntheticStrictRefusedCredentialToken";
    // Two inputs: valid JSON carrying the sentinel, and the bare identifier,
    // which the parser echoes verbatim if a refusal ever falls through to it.
    expect(parserMessageFor(secret)).toContain(secret);
    for (const stored of [JSON.stringify({ access_token: secret }), secret]) {
      // The sentinel is present verbatim in the input, so a message that
      // quoted the value would contain it. The check below is not vacuous.
      expect(stored).toContain(secret);
      setRequireEncryptedCredentials(true);
      for (const read of [() => decryptJson(stored), () => decryptBoundJson(stored, ROW_A)]) {
        let message = "";
        try { read(); } catch (error) { message = (error as Error).message; }
        expect(message).toContain("plaintext credential refused");
        expect(message).not.toContain(secret);
      }
    }
  });

  test("refuses plaintext only, not an un-converted enc1: row", () => {
    const unbound = encryptJson({ access_token: "syntheticStrictUnconvertedToken" });
    const bound = encryptBoundJson({ access_token: "syntheticStrictBoundToken" }, ROW_A);
    setRequireEncryptedCredentials(true);
    expect(decryptJson(unbound)).toEqual({ access_token: "syntheticStrictUnconvertedToken" });
    expect(decryptBoundJson(unbound, ROW_A)).toEqual({ access_token: "syntheticStrictUnconvertedToken" });
    expect(decryptBoundJson(bound, ROW_A)).toEqual({ access_token: "syntheticStrictBoundToken" });
    // Strict mode is about the absence of an envelope, not about the key.
    expect(() => decryptBoundJson(bound, ROW_B)).toThrow(/auth verification failed/);
  });

  test("the conversion escape hatch lifts the gate only for its own scope", () => {
    const legacy = JSON.stringify({ access_token: "syntheticEscapeHatchToken" });
    setRequireEncryptedCredentials(true);
    expect(withLegacyPlaintextReads(() => decryptJson(legacy)))
      .toEqual({ access_token: "syntheticEscapeHatchToken" });
    expect(requireEncryptedCredentials()).toBe(true);
    expect(() => decryptJson(legacy)).toThrow(/plaintext credential refused/);
  });

  test("the escape hatch restores the gate even when the body throws", () => {
    setRequireEncryptedCredentials(true);
    expect(() => withLegacyPlaintextReads(() => { throw new Error("fixture failure"); })).toThrow("fixture failure");
    expect(requireEncryptedCredentials()).toBe(true);
  });
});
