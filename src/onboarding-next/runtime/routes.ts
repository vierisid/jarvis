import { OPERATIONS, type Operation } from './contract.ts';
import { RuntimeError, type OnboardingRuntime } from './runtime.ts';
const PREFIX = '/api/onboarding-next/v1';
const LIMIT = 32 * 1024;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export const OPERATION_PATHS: Record<Operation, string> = {
  'journey.read': '/journey/read', 'journey.transition': '/journey/transition',
  'setup.read': '/setup/read', 'setup.complete': '/setup/complete',
  'google.read': '/google/read', 'google.begin': '/google/begin',
  'google.cancel': '/google/cancel', 'google.callback': '/google/callback',
  'interview.command': '/interview/command', 'tour.command': '/tour/command',
  'intent.validate': '/intent/validate', 'build.submit': '/build/submit',
  'build.read': '/build/read', 'build.cancel': '/build/cancel', 'result.read': '/result/read',
};
export type Handler = (request: Request) => Promise<Response>;
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers });
const fail = (e: unknown) => reply({ schemaVersion: 1, error: e instanceof RuntimeError ? e.reason : 'provider_unavailable' }, e instanceof RuntimeError ? e.status : 503);

async function envelope(req: Request): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new RuntimeError('invalid_request', 415);
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > LIMIT)) throw new RuntimeError('request_too_large', 413);
  if (!req.body) throw new RuntimeError('invalid_request', 400);
  const reader = req.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    const stop = (status: number) => {
      void reader.cancel().catch(() => {});
      reject(new RuntimeError('invalid_request', status));
    };
    onAbort = () => stop(400);
    req.signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => stop(408), 5000);
    if (req.signal.aborted) onAbort();
  });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), stopped]);
      if (done) break;
      length += value.byteLength;
      if (length > LIMIT) { void reader.cancel().catch(() => {}); throw new RuntimeError('request_too_large', 413); }
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new RuntimeError('invalid_request', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'input,schemaVersion') throw new RuntimeError('invalid_request', 400);
  if (body.schemaVersion !== 1) throw new RuntimeError('unsupported_version', 409);
  if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new RuntimeError('invalid_request', 400);
  // Authority never comes from a body, including common legacy/client aliases.
  if (['actorId', 'userId', 'projectId', 'scope', 'vault', 'vaultPath', 'enabled', 'release'].some(k => Object.hasOwn(body.input, k))) throw new RuntimeError('invalid_request', 400);
  return body.input;
}
export function createOnboardingRoutes(runtime: OnboardingRuntime): Record<string, { GET?: Handler; POST?: Handler }> {
  const routes: Record<string, { GET?: Handler; POST?: Handler }> = {
    [`${PREFIX}/status`]: { GET: async req => {
      try { return reply(await runtime.status(req)); } catch (e) { return fail(e); }
    } },
  };
  for (const operation of Object.keys(OPERATIONS) as Operation[]) routes[`${PREFIX}${OPERATION_PATHS[operation]}`] = {
    POST: async req => {
      try {
        // Authenticate before reading a body. Status is read-only and also
        // prevents even parsing commands on a disabled/partial deployment.
        const status = await runtime.status(req);
        if (!status.ready) throw new RuntimeError(status.reason, 503);
        const input = await envelope(req);
        return reply({ schemaVersion: 1, result: await runtime.execute(req, operation, input) });
      } catch (e) { return fail(e); }
    },
  };
  return routes;
}
