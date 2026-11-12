/**
 * `jarvis notch demo [<moment> | list | stop]`: plays a canned moment on the
 * notch of a running brain, through the same path a real one takes.
 *
 * It talks to the brain's demo endpoint, which exists only when the brain was
 * started with JARVIS_NOTCH=1 and a JARVIS_NOTCH_DEMO secret, and wants that
 * same secret back (src/notch/demo-gate.ts). This command reads it from its
 * own environment. It is a tool for trying the surface by hand, not a feature.
 */
import { NOTCH_DEMO_ENV, NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH } from '../notch/demo-gate.ts';
import { resolveStopPort } from './lifecycle.ts';

export interface NotchCliDeps {
  env: Record<string, string | undefined>;
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;
  /** The port the running brain listens on, or null when none can be found. */
  port: () => number | null;
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultDeps: NotchCliDeps = {
  env: process.env,
  fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }),
  port: () => resolveStopPort().port,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

const USAGE = 'usage: jarvis notch demo [<moment> | list | stop] [--port <n>]';

export async function cmdNotch(args: string[], deps: NotchCliDeps = defaultDeps): Promise<number> {
  const rest = [...args];
  let port: number | null = null;
  const flag = rest.indexOf('--port');
  if (flag >= 0) {
    const given = Number(rest[flag + 1]);
    if (!Number.isInteger(given) || given < 1 || given > 65535) {
      deps.err(USAGE);
      return 2;
    }
    port = given;
    rest.splice(flag, 2);
  }
  if (rest[0] !== 'demo' || rest.length > 2 || rest.some((arg) => arg.startsWith('--'))) {
    deps.err(USAGE);
    return 2;
  }
  const moment = rest[1] ?? 'list';

  const secret = deps.env[NOTCH_DEMO_ENV];
  if (!secret) {
    deps.err(`${NOTCH_DEMO_ENV} is not set.`);
    deps.err(`Start the brain with JARVIS_NOTCH=1 and ${NOTCH_DEMO_ENV}=<a secret of 16 or more characters>, then run this with the same ${NOTCH_DEMO_ENV}.`);
    return 2;
  }
  port ??= deps.port();
  if (port === null) {
    deps.err('No running brain was found. Start it first, or name its port with --port.');
    return 1;
  }

  let res: Response;
  try {
    res = await deps.fetch(`http://127.0.0.1:${port}${NOTCH_DEMO_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [NOTCH_DEMO_HEADER]: secret },
      body: JSON.stringify({ moment }),
    });
  } catch (error) {
    deps.err(`The brain on port ${port} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const body = await res.json().catch(() => null) as
    { moments?: string[]; running?: string | null; pages?: number; error?: string } | null;

  if (res.status === 404) {
    deps.err(`The brain on port ${port} has no notch demo.`);
    deps.err(`Either it was started without JARVIS_NOTCH=1 and a ${NOTCH_DEMO_ENV} secret, or its secret is not this one.`);
    return 1;
  }
  if (res.status === 400) {
    deps.err(body?.error ?? 'The brain refused that.');
    if (body?.moments?.length) deps.err(`Moments: ${body.moments.join(', ')}`);
    return 2;
  }
  if (!res.ok || !body) {
    deps.err(`The brain on port ${port} answered ${res.status}.`);
    return 1;
  }

  if (moment === 'list') {
    deps.out(`Moments: ${(body.moments ?? []).join(', ')}`);
    if (body.running) deps.out(`Playing now: ${body.running}`);
  } else if (moment === 'stop') {
    deps.out('Stopped. The notch is at rest.');
  } else {
    deps.out(`Playing "${moment}".`);
  }
  if (!body.pages) deps.out('No desktop app is showing the notch right now, so there is nothing to see it on.');
  return 0;
}
