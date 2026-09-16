/**
 * AES-256-GCM at-rest encryption for `app_connection.value`.
 *
 * Tests cover:
 *   - encrypt -> decrypt round-trip preserves the value
 *   - ciphertext changes per call (IV is fresh)
 *   - tampered ciphertext fails decryption (auth tag catches it)
 *   - wrong key fails decryption
 *   - legacy plaintext JSON passes through `decryptJson` unchanged
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  decryptJson,
  encryptJson,
  isEncrypted,
  setEncryptionKey,
} from "./encryption";

const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);

beforeEach(() => setEncryptionKey(KEY_A));
afterEach(() => setEncryptionKey(null));

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
    const secret = "synthetic-malformed-credential-token";
    let message = "";
    try { decryptJson(secret); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("legacy plaintext is not valid JSON");
    expect(message).not.toContain(secret);
  });

  test("authenticated but invalid JSON errors never include decrypted credential text", () => {
    const secret = "synthetic-invalid-decrypted-credential";
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
