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
 * sentences, and can make the fixed test items of ./fixtures.ts (an approval,
 * a promise, a question, a failure), each of which does one harmless thing
 * that is written down there. On an isolated development brain with no real
 * model it can also load a script into the stand-in model and send it words
 * as if typed or spoken (./script.ts); such a script may call three fixed,
 * harmless tools and nothing else, and none of that works once a real model
 * is set up. Through those three routes it reaches no data and chooses nothing
 * that runs.
 *
 * The fourth route, the mail study (./mail/study-route.ts), is worth more. On
 * a brain whose owner signed in to Gmail in Jarvis's own browser, the secret
 * reads that mail, reads the connected calendar, and calls the brain's model.
 * It still sends nothing and goes nowhere but Gmail. So the secret is kept to
 * the computer the brain runs on (scripts/notch/try.sh keeps it in the test
 * data folder), and the brain says all of this when it starts with the gate
 * open.
 */
import { MIN_SECRET_LENGTH, debugRpcTokenMatches } from '../daemon/debug-rpc-gate.ts';

export const NOTCH_DEMO_ENV = 'JARVIS_NOTCH_DEMO';
export const NOTCH_DEMO_HEADER = 'x-notch-demo-token';
export const NOTCH_DEMO_PATH = '/api/notch/demo';
/** The second route behind the same gate: makes one real test item (./fixtures.ts). */
export const NOTCH_FIXTURE_PATH = '/api/notch/fixture';
/** The third: the stand-in model's script, and words sent to it as if typed or spoken (./script.ts). */
export const NOTCH_SCRIPT_PATH = '/api/notch/script';
/**
 * The fourth: the mail study (./mail/study-route.ts). On a brain whose owner
 * signed in to Gmail in Jarvis's own browser this one reaches their mail, which
 * the others never do: the secret is worth that much more there.
 */
export const NOTCH_STUDY_PATH = '/api/notch/study';

const GATED_PATHS: readonly string[] = [NOTCH_DEMO_PATH, NOTCH_FIXTURE_PATH, NOTCH_SCRIPT_PATH, NOTCH_STUDY_PATH];

/**
 * Whether a path is one of the routes behind this gate, with the gate open.
 * The server lets such a path past its own sign-in, because the route asks
 * for the gate's secret itself. Asked here, in one place, so that a route
 * added behind the gate cannot be left unreachable behind the sign-in: the
 * routes' own test holds every one of them to this.
 */
export function notchGatedPath(pathname: string): boolean {
  return GATED_PATHS.includes(pathname) && notchDemoGate() !== null;
}

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
