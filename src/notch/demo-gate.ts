/**
 * Gate for the notch's demo endpoint (POST /api/notch/demo).
 *
 * `jarvis notch demo <moment>` plays a canned moment on the notch, through the
 * same path a real one takes. A command line has no dashboard session, so the
 * endpoint cannot sit behind the usual check. It is built like the one other
 * endpoint a local tool calls, /api/debug/rpc (daemon/debug-rpc-gate.ts), and
 * opt-in the same way: the brain must be started with JARVIS_NOTCH_DEMO set to
 * a secret of at least MIN_SECRET_LENGTH characters, and every request must
 * echo it in the `x-notch-demo-token` header. Without the secret, with the
 * notch switch off, or on a hosted install, the route is absent (404).
 *
 * What the secret is worth: whoever holds it can make the notch show sample
 * sentences. It reaches no data and runs nothing. It is still a secret,
 * because an open gate is a way to put words in Jarvis's mouth.
 */
import { MIN_SECRET_LENGTH, debugRpcTokenMatches } from '../daemon/debug-rpc-gate.ts';

export const NOTCH_DEMO_ENV = 'JARVIS_NOTCH_DEMO';
export const NOTCH_DEMO_HEADER = 'x-notch-demo-token';
export const NOTCH_DEMO_PATH = '/api/notch/demo';

export type NotchDemoGateState = 'off' | 'too-short' | 'refused-hosted' | 'notch-off' | 'open';

let activeSecret: string | null = null;

/**
 * Resolves the gate once, at startup. The secret is removed from `env`
 * whatever the outcome, for the reason given in debug-rpc-gate.ts.
 */
export function initNotchDemoGate(
  opts: { hosted: boolean; notch: boolean },
  env: Record<string, string | undefined> = process.env,
): NotchDemoGateState {
  const raw = env[NOTCH_DEMO_ENV];
  delete env[NOTCH_DEMO_ENV];
  activeSecret = null;
  if (!raw) return 'off';
  if (raw.length < MIN_SECRET_LENGTH) return 'too-short';
  if (opts.hosted) return 'refused-hosted';
  // With the notch off there is nothing to demonstrate, and "off means
  // silent" includes this route.
  if (!opts.notch) return 'notch-off';
  activeSecret = raw;
  return 'open';
}

/** The active secret, or null when the route must not exist. */
export function notchDemoGate(): string | null {
  return activeSecret;
}

/** Constant-time compare of a presented token against the gate's secret. */
export function notchDemoTokenMatches(presented: string | null | undefined, gate: string): boolean {
  return debugRpcTokenMatches(presented, gate);
}
