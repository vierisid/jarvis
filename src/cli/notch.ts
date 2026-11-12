/**
 * `jarvis notch demo [<moment> | list | stop]`: plays a canned moment on the
 * notch of a running brain, through the same path a real one takes.
 *
 * `jarvis notch fixture [<kind> | list]`: makes one real thing for the notch to
 * be tried on: an approval, a promise, a question, a failure (what each one
 * is and does: src/notch/fixtures.ts).
 *
 * Both talk to endpoints that exist only when the brain was started with
 * JARVIS_NOTCH=1 and a JARVIS_NOTCH_DEMO secret, and want that same secret
 * back (src/notch/demo-gate.ts). This command reads it from its own
 * environment. They are tools for trying the notch by hand, not features.
 */
import { NOTCH_DEMO_ENV, NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH, NOTCH_FIXTURE_PATH } from '../notch/demo-gate.ts';
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

const USAGE = [
  'usage: jarvis notch demo [<moment> | list | stop] [--port <n>]',
  '       jarvis notch fixture [<kind> | list] [--in <seconds>] [--port <n>]',
].join('\n');

/** Takes `--name <whole number>` out of `args`. Undefined when absent, null when it is not a number in range. */
function takeNumber(args: string[], name: string, min: number, max: number): number | null | undefined {
  const flag = args.indexOf(name);
  if (flag < 0) return undefined;
  const given = Number(args[flag + 1]);
  args.splice(flag, 2);
  return Number.isInteger(given) && given >= min && given <= max ? given : null;
}

export async function cmdNotch(args: string[], deps: NotchCliDeps = defaultDeps): Promise<number> {
  const rest = [...args];
  const givenPort = takeNumber(rest, '--port', 1, 65535);
  const dueIn = takeNumber(rest, '--in', 5, 86_400);
  const what = rest[0];
  if (givenPort === null || dueIn === null || (what !== 'demo' && what !== 'fixture')
    || rest.length > 2 || rest.some((arg) => arg.startsWith('--')) || (dueIn !== undefined && what !== 'fixture')) {
    deps.err(USAGE);
    return 2;
  }
  const name = rest[1] ?? 'list';

  const secret = deps.env[NOTCH_DEMO_ENV];
  if (!secret) {
    deps.err(`${NOTCH_DEMO_ENV} is not set.`);
    deps.err(`Start the brain with JARVIS_NOTCH=1 and ${NOTCH_DEMO_ENV}=<a secret of 16 or more characters>, then run this with the same ${NOTCH_DEMO_ENV}.`);
    return 2;
  }
  const port = givenPort ?? deps.port();
  if (port === null) {
    deps.err('No running brain was found. Start it first, or name its port with --port.');
    return 1;
  }

  let res: Response;
  try {
    res = await deps.fetch(`http://127.0.0.1:${port}${what === 'demo' ? NOTCH_DEMO_PATH : NOTCH_FIXTURE_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [NOTCH_DEMO_HEADER]: secret },
      body: JSON.stringify(what === 'demo' ? { moment: name } : { kind: name, ...(dueIn === undefined ? {} : { in: dueIn }) }),
    });
  } catch (error) {
    deps.err(`The brain on port ${port} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const body = await res.json().catch(() => null) as {
    moments?: string[]; running?: string | null; kinds?: string[]; made?: string; pages?: number; error?: string;
  } | null;

  if (res.status === 404) {
    deps.err(`The brain on port ${port} has no notch ${what}.`);
    deps.err(`Either it was started without JARVIS_NOTCH=1 and a ${NOTCH_DEMO_ENV} secret, or its secret is not this one.`);
    return 1;
  }
  if (res.status === 400) {
    deps.err(body?.error ?? 'The brain refused that.');
    if (body?.moments?.length) deps.err(`Moments: ${body.moments.join(', ')}`);
    if (body?.kinds?.length) deps.err(`Fixtures: ${body.kinds.join(', ')}`);
    return 2;
  }
  if (!res.ok || !body) {
    deps.err(body?.error ?? `The brain on port ${port} answered ${res.status}.`);
    return 1;
  }

  if (what === 'fixture') {
    if (name === 'list') deps.out(`Fixtures: ${(body.kinds ?? []).join(', ')}`);
    else deps.out(body.made ?? `Made "${name}".`);
  } else if (name === 'list') {
    deps.out(`Moments: ${(body.moments ?? []).join(', ')}`);
    if (body.running) deps.out(`Playing now: ${body.running}`);
  } else if (name === 'stop') {
    deps.out('Stopped. The notch is at rest.');
  } else {
    deps.out(`Playing "${name}".`);
  }
  if (!body.pages) deps.out('No desktop app is showing the notch right now, so there is nothing to see it on.');
  return 0;
}
