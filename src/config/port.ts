/**
 * One reading of `daemon.port`, shared by every reader of it.
 *
 * There are two independent readers and they MUST agree: the daemon reads the
 * port through `loadConfig` and binds it (src/config/loader.ts,
 * src/daemon/index.ts), while `jarvis stop` reads the same key straight out of
 * the YAML (`readConfiguredPort` in src/cli/lifecycle.ts) to know which port to
 * verify and clear. When they disagree, `jarvis stop` SIGTERMs and then
 * SIGKILLs whatever same-user process happens to hold the port it picked --
 * which is an unrelated listener, not Jarvis.
 *
 * That is exactly what a quoted port did (#550):
 *
 *     daemon:
 *       port: "8080"
 *
 * YAML makes a quoted scalar a string. `Bun.serve` coerces it, so the daemon
 * bound 8080; both readers only accepted `typeof === 'number'`, so
 * `writeLockedPort` recorded nothing and the stop path fell through to the
 * 3142 default. Nothing warned.
 *
 * A plain decimal string is coerced, which is what a quoted port is in
 * practice. Note that YAML's own integer forms (`0x1f90`, `8e3`, `+8080`) have
 * already become numbers by the time they arrive here, so they are accepted as
 * numbers while their QUOTED spellings are refused as strings. That asymmetry
 * is the point -- a quoted scalar is text, and text that is not simply a number
 * is a typo worth reporting -- and it cannot make the two paths disagree,
 * because both call this same function.
 */

/**
 * The ports the daemon can actually bind.
 *
 * 0 is excluded deliberately: `Bun.serve` reads it as "bind any free port",
 * which would put the daemon somewhere nobody can predict and leave
 * `jarvis stop` hunting a port it was never on.
 */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

/**
 * Decimal digits and nothing else, so a typo is REFUSED rather than guessed at.
 *
 * `parseInt`, which is what the `JARVIS_PORT` and `--port` readers use, would
 * take "8080abc" as 8080, "0x1f90" as 0 and "8080.5" as 8080. Silently binding
 * a port the user did not write is the failure mode this whole module exists to
 * prevent, so a value that is not exactly a number is an error here.
 */
const DECIMAL_DIGITS = /^[0-9]+$/;

/** What `daemon.port` says, once. */
export type PortSetting =
  /** Not set at all: the caller applies its own default. */
  | { kind: 'absent' }
  /** A port, coerced from a number or from a numeric string. */
  | { kind: 'valid'; port: number }
  /**
   * Set to something that is not a port. NOT the same as absent: a caller that
   * treats this as "nothing was configured" and falls back to 3142 is the #550
   * bug. `problem` completes the sentence "daemon.port ...".
   */
  | { kind: 'invalid'; problem: string };

/**
 * How a rejected value is named back to the user, without dumping a whole
 * mapping -- or a whole novel -- into the message. This string reaches the
 * daemon's boot error, `jarvis stop`'s output and the dashboard label, so a
 * `daemon.port` holding a megabyte of text must not be reproduced in all three.
 */
export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    // Clamped BEFORE quoting, so the ellipsis cannot land in the middle of a
    // "\uXXXX" escape that JSON.stringify produced.
    return JSON.stringify(value.length > 37 ? `${value.slice(0, 37)}...` : value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return typeof value;
}

function invalid(value: unknown): PortSetting {
  return {
    kind: 'invalid',
    problem: `must be a whole number between ${MIN_PORT} and ${MAX_PORT} (a quoted "8080" is fine), got ${describeValue(value)}`,
  };
}

/**
 * Read a raw YAML value as a port.
 *
 * A number passes through; a numeric string is coerced, so `port: "8080"` and
 * `port: 8080` resolve identically wherever this is used. Everything else --
 * out of range, fractional, a boolean, a list, a mapping, a string with
 * anything but digits in it, an empty or whitespace-only string -- is
 * `invalid`, never a silent fallback.
 */
export function readPortSetting(value: unknown): PortSetting {
  if (value === undefined || value === null) return { kind: 'absent' };

  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
      ? { kind: 'valid', port: value }
      : invalid(value);
  }

  if (typeof value === 'string') {
    // Trimmed because YAML block scalars and hand-edited quotes pick up
    // spaces; "" and "   " have no digits and so are rejected below.
    const text = value.trim();
    if (!DECIMAL_DIGITS.test(text)) return invalid(value);
    // Digits only, so Number() cannot return NaN; a very long run of digits
    // exceeds MAX_PORT and is rejected on range.
    const port = Number(text);
    return port >= MIN_PORT && port <= MAX_PORT ? { kind: 'valid', port } : invalid(value);
  }

  return invalid(value);
}

/**
 * The port, or undefined when the setting is absent, throwing for a value that
 * is not a port at all. For the daemon's own load path, where a config the
 * daemon cannot honour has to be an error at boot and not a surprise port.
 */
export function requirePort(value: unknown, label: string): number | undefined {
  const setting = readPortSetting(value);
  if (setting.kind === 'absent') return undefined;
  if (setting.kind === 'invalid') throw new Error(`${label} ${setting.problem}`);
  return setting.port;
}
