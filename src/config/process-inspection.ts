/**
 * One reading of `daemon.allow_process_inspection`, shared by every reader.
 *
 * The key is the escape hatch for #546: on Linux the daemon calls
 * `prctl(PR_SET_DUMPABLE, 0)` at startup so that no same-uid process can read
 * `/proc/<daemon pid>/environ`, `/proc/<daemon pid>/fd/` or attach a debugger
 * to it. Setting this to true skips that call, for the operator who needs
 * strace, gdb or a core dump of their own daemon.
 *
 * Shaped after src/config/port.ts (#565) and for the same reason: a key read
 * as `parsed?.daemon?.x` at each call site is how two readers end up
 * disagreeing about what the file says. There is one reader here, it names an
 * explicit `invalid` state, and no caller is allowed to mistake that state for
 * "nothing was configured".
 *
 * NO ENV OVERRIDE, deliberately, unlike `JARVIS_PORT`. This key turns a
 * security control OFF, so the way to set it has to be at least as hard to
 * reach as the thing it protects, and the config file is.
 * `~/.jarvis/config.yaml` is refused outright on READ (`jarvis-config`,
 * #528/#551), and a `write_file` to it is rated exec-on-write (#522): it costs
 * `execute_command` authority, and below that level it produces an approval
 * card naming the file rather than going through. So a prompt-injected turn
 * cannot quietly open the hatch.
 *
 * An environment variable would be strictly weaker. It needs no card at all;
 * the daemon can be started from a command the assistant ran (#514); and a
 * stale `export` in a shell profile or a unit drop-in would silently disable
 * the hardening on the next boot with nothing in the config to show for it. If
 * an override is ever genuinely needed, route it through this same function AND
 * make the daemon log loudly that an environment variable, not the config, is
 * what opened the hatch.
 *
 * WHY THE COERCION. `yaml` parses to the YAML 1.2 core schema, where only
 * `true`/`false` are booleans. The YAML 1.1 spellings people actually write --
 *
 *     daemon:
 *       allow_process_inspection: yes
 *
 * -- arrive here as the STRING "yes", and a plain `=== true` test would read
 * that as "do not allow" and harden anyway. That is the exact shape of the
 * quoted-port bug (#550): a value the user clearly meant, silently not
 * honoured. So the 1.1 spellings and the quoted forms are coerced, and
 * anything else is `invalid` rather than guessed at.
 *
 * WHERE THIS DIVERGES FROM port.ts, deliberately. A malformed `daemon.port`
 * throws and the config will not load, because a port that cannot be honoured
 * has no safe reading and two separate readers have to agree on it. A
 * malformed value HERE has an obvious safe reading -- harden, the default --
 * and this key has one reader. Throwing would take `jarvis devices`, `jarvis
 * export` and `scripts/setup-config.ts` down over a typo in a
 * defense-in-depth knob, which costs more than it buys. So `resolveAllow`
 * warns loudly and hardens. The one direction that is never taken silently is
 * the permissive one.
 */

// How a rejected value is named back to the user: clamped and quoted, so a key
// holding a megabyte of text is not reproduced in the daemon's log. Shared with
// port.ts rather than copied -- the two warnings should read alike, and one
// implementation cannot drift from the other.
import { describeValue } from './port.ts';

/** What `daemon.allow_process_inspection` says, once. */
export type ProcessInspectionSetting =
  /** Not set at all: the caller applies its own default, which is "harden". */
  | { kind: 'absent' }
  /** A boolean, coerced from a boolean, a 1/0, or a YAML 1.1 spelling of one. */
  | { kind: 'valid'; allow: boolean }
  /**
   * Set to something that is not a yes-or-no. NOT the same as absent, and
   * never silently the same as `true`: a caller that reads this as "the
   * operator asked for inspection" would disable a security control over a
   * typo. `problem` completes the sentence "daemon.allow_process_inspection
   * ...".
   */
  | { kind: 'invalid'; problem: string };

/**
 * The spellings accepted for each answer, lower-cased and trimmed. Kept as
 * explicit sets rather than a truthiness test so that `allow_process_inspection:
 * "false"` -- a string, and a truthy one -- cannot ever mean true.
 */
const TRUE_WORDS = new Set(['true', 'yes', 'on', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'off', '0']);

function invalid(value: unknown): ProcessInspectionSetting {
  return {
    kind: 'invalid',
    problem: `must be true or false (yes/no, on/off and 1/0 are accepted), got ${describeValue(value)}`,
  };
}

/** Read a raw YAML value as the allow-inspection flag. */
export function readProcessInspectionSetting(value: unknown): ProcessInspectionSetting {
  if (value === undefined || value === null) return { kind: 'absent' };
  if (typeof value === 'boolean') return { kind: 'valid', allow: value };
  // A bare 1 or 0 in the file is a number by the time it reaches us.
  if (typeof value === 'number') {
    if (value === 1) return { kind: 'valid', allow: true };
    if (value === 0) return { kind: 'valid', allow: false };
    return invalid(value);
  }
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (TRUE_WORDS.has(text)) return { kind: 'valid', allow: true };
    if (FALSE_WORDS.has(text)) return { kind: 'valid', allow: false };
    return invalid(value);
  }
  return invalid(value);
}

/**
 * The flag as a plain boolean for the daemon's startup path: true only when
 * the file actually says so.
 *
 * Absent is false (harden, the default) and so is invalid -- with a warning,
 * because an operator who wrote `allow_process_inspection: maybe` meant to
 * turn something off and needs to know it is still on. The warning is the
 * whole mitigation for not throwing; do not quiet it.
 */
export function resolveAllowProcessInspection(
  value: unknown,
  label: string,
  warn: (line: string) => void = console.warn,
): boolean {
  const setting = readProcessInspectionSetting(value);
  if (setting.kind === 'valid') return setting.allow;
  if (setting.kind === 'invalid') {
    // Names the subject, because loadConfig also runs in `jarvis devices`,
    // `jarvis export`, `jarvis doctor` and scripts/setup-config.ts, where "is
    // blocked" would be claiming something about the CLI process -- and on
    // macOS, where nothing is ever blocked at all.
    warn(
      `${label} ${setting.problem}; ignoring it, so the daemon will keep blocking ` +
        'process inspection on Linux. Write `true` if you meant to allow it.',
    );
  }
  return false;
}
