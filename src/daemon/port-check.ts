/**
 * Is the port the daemon is about to listen on free?
 *
 * Found late, a taken port cost about 13 seconds of full boot and ended in a
 * raw EADDRINUSE stack. Checked first, it is one plain sentence: which port,
 * and how to choose another.
 */

import { createServer } from 'node:net';

/** A port the daemon cannot listen on, with the owner-facing explanation as its message. */
export class PortUnavailableError extends Error {
  constructor(readonly port: number, readonly reason: 'in_use' | 'not_allowed', message: string) {
    super(message);
    this.name = 'PortUnavailableError';
  }
}

type ProbeResult = 'free' | 'in_use' | 'not_allowed' | 'unknown';

/** Try to listen on the port for an instant. Anything unexpected counts as "unknown", never as busy. */
export function probePort(port: number, host: string = '0.0.0.0'): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE' ? 'in_use' : err.code === 'EACCES' || err.code === 'EPERM' ? 'not_allowed' : 'unknown');
    });
    probe.listen({ port, host }, () => probe.close(() => resolve('free')));
  });
}

/** The first port above `port` that is free, for the suggestion. Null when none of the next ten is. */
async function nextFreePort(port: number, host?: string): Promise<number | null> {
  for (let candidate = port + 1; candidate <= Math.min(port + 10, 65535); candidate++) {
    if (await probePort(candidate, host) === 'free') return candidate;
  }
  return null;
}

/** How to see which program listens on a port, for this platform. */
function whoListensCommand(port: number): string {
  return process.platform === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

/** A port to suggest when no probed one is known: never outside 1..65535. */
function fallbackPort(port: number): number {
  return port < 65535 ? port + 1 : port - 1;
}

// No "run: jarvis stop" here. When this message is printed the starting
// Jarvis already holds the lock for its data folder, so the listener is never
// a Jarvis for this folder; and `jarvis stop` with no lock held clears the
// port by signalling whatever listens on it, which here is someone else's
// program.
export function portInUseMessage(port: number, suggestion: number | null): string {
  const other = suggestion ?? fallbackPort(port);
  return `Port ${port} is already in use, so Jarvis did not start. Another program is listening on it `
    + `(possibly a Jarvis with a different data folder). To see which one, run: ${whoListensCommand(port)}\n`
    + `To use a different port, run: jarvis start --port ${other}  (or set JARVIS_PORT=${other}, or daemon.port in config.yaml).`;
}

export function portNotAllowedMessage(port: number): string {
  const why = port < 1024
    ? 'Ports below 1024 need extra permission. Use a port above 1023'
    : 'The system does not let this user listen on it. Use another port';
  const example = port === 3142 ? 3143 : 3142;
  return `Jarvis is not allowed to listen on port ${port}. ${why}, for example: jarvis start --port ${example}  (or set JARVIS_PORT, or daemon.port in config.yaml).`;
}

/** Throws a PortUnavailableError when the port is busy or not allowed; resolves otherwise. */
export async function assertPortFree(port: number, host?: string): Promise<void> {
  const result = await probePort(port, host);
  if (result === 'in_use') throw new PortUnavailableError(port, 'in_use', portInUseMessage(port, await nextFreePort(port, host)));
  if (result === 'not_allowed') throw new PortUnavailableError(port, 'not_allowed', portNotAllowedMessage(port));
}

/** True when a startup failure is Bun's "address already in use" for a TCP listen. */
export function isAddressInUseError(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 'EADDRINUSE' || (typeof e?.message === 'string' && /EADDRINUSE|address already in use|is port \d+ in use/i.test(e.message));
}
