/**
 * `piecesManagedByHost` — the switch that decides whether this install's
 * pieces are the user's to install and remove, or the host's. Both Library
 * mutations are gated on it, so its edge cases are worth pinning directly
 * rather than only through the routes.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { piecesManagedByHost } from "./shared";

const ENV = "JARVIS_SHARED_PIECES_DIR";
let prev: string | undefined;

beforeEach(() => {
  prev = process.env[ENV];
  delete process.env[ENV];
});

afterEach(() => {
  if (prev === undefined) delete process.env[ENV];
  else process.env[ENV] = prev;
});

describe("piecesManagedByHost", () => {
  test("an explicit dir is managed; null is not", () => {
    expect(piecesManagedByHost("/opt/jarvis-pieces/1.2.3")).toBe(true);
    expect(piecesManagedByHost(null)).toBe(false);
  });

  test("a blank configured dir is NOT managed", () => {
    // `resolve("")` is the process cwd, so treating whitespace as a real dir
    // would declare a self-hosted install managed and take its Library away
    // over a stray space in config.yaml.
    expect(piecesManagedByHost("")).toBe(false);
    expect(piecesManagedByHost("   ")).toBe(false);
  });

  test("undefined consults the env var", () => {
    expect(piecesManagedByHost(undefined)).toBe(false);
    process.env[ENV] = "/opt/jarvis-pieces/1.2.3";
    expect(piecesManagedByHost(undefined)).toBe(true);
  });

  test("an explicit null OUTRANKS the env var", () => {
    // `null` is the daemon saying "config resolved to no shared tree". A
    // leftover env var must not override that and silently re-manage the
    // install; config wins, exactly as it does in resolveSharedRuntimePaths.
    process.env[ENV] = "/opt/jarvis-pieces/1.2.3";
    expect(piecesManagedByHost(null)).toBe(false);
  });
});
