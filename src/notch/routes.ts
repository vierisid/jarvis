/**
 * The notch's page and its two routes.
 *
 * The page is a built file, ui/notch.html, served like every other page of
 * the dashboard: from the static directory, behind the session check. It is
 * inert by itself: it draws nothing until the brain answers its hello, and a
 * brain with the switch off never does.
 *
 * The routes are the demo, fixture and script endpoints, which exist only with
 * the switch on and their gate open (./demo-gate.ts).
 */
import { NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH, NOTCH_FIXTURE_PATH, NOTCH_SCRIPT_PATH, notchDemoGate, notchDemoTokenMatches } from './demo-gate.ts';
import { notchScriptOp } from './script.ts';
import type { NotchScriptDeps } from './script.ts';

/** Where the desktop app is told to point the notch's window. */
export const NOTCH_PAGE_PATH = '/notch.html';

/** What the demo endpoint needs. */
export interface NotchRouteDeps {
  demo?: {
    names(): string[];
    play(name: string): boolean;
    stop(): void;
    running(): string | null;
  } | null;
  /** Makes real test items (./fixtures.ts). */
  fixtures?: {
    kinds(): string[];
    /** Comes back with a sentence saying what was made, or throws one saying why not. */
    make(kind: string, options: { in?: number }): Promise<string>;
  } | null;
  /** The stand-in model's script, and words sent as if typed or spoken (./script.ts). */
  script?: NotchScriptDeps | null;
  /** How many notch pages are up and listening. */
  pages?: () => number;
}

type NotchRoutes = Record<string, { POST: (req: Request) => Promise<Response> }>;

const notFound = (): Response => Response.json({ error: 'Not found' }, { status: 404 });

export function notchRoutes(enabled: boolean, deps: NotchRouteDeps = {}): NotchRoutes {
  // Off: no route. A request gets the ordinary 404.
  if (!enabled) return {};
  return {
    [NOTCH_DEMO_PATH]: {
      POST: async (req) => {
        const gate = notchDemoGate();
        const demo = deps.demo;
        // A closed gate and a wrong token look the same: there is nothing here.
        if (!gate || !demo || !notchDemoTokenMatches(req.headers.get(NOTCH_DEMO_HEADER), gate)) return notFound();
        const body = await req.json().catch(() => null) as { moment?: unknown } | null;
        const moment = typeof body?.moment === 'string' ? body.moment : '';
        const pages = deps.pages?.() ?? 0;
        if (moment === 'list') return Response.json({ moments: demo.names(), running: demo.running(), pages });
        if (moment === 'stop') {
          demo.stop();
          return Response.json({ stopped: true, pages });
        }
        if (!demo.play(moment)) {
          return Response.json({ error: `No moment is called "${moment.slice(0, 60)}"`, moments: demo.names() }, { status: 400 });
        }
        return Response.json({ playing: moment, pages });
      },
    },
    [NOTCH_FIXTURE_PATH]: {
      POST: async (req) => {
        const gate = notchDemoGate();
        const fixtures = deps.fixtures;
        if (!gate || !fixtures || !notchDemoTokenMatches(req.headers.get(NOTCH_DEMO_HEADER), gate)) return notFound();
        const body = await req.json().catch(() => null) as { kind?: unknown; in?: unknown } | null;
        const kind = typeof body?.kind === 'string' ? body.kind : '';
        const pages = deps.pages?.() ?? 0;
        if (kind === 'list') return Response.json({ kinds: fixtures.kinds(), pages });
        if (!fixtures.kinds().includes(kind)) {
          return Response.json({ error: `No fixture is called "${kind.slice(0, 60)}"`, kinds: fixtures.kinds() }, { status: 400 });
        }
        const dueIn = typeof body?.in === 'number' && Number.isInteger(body.in) && body.in >= 5 && body.in <= 86_400 ? body.in : undefined;
        try {
          return Response.json({ made: await fixtures.make(kind, { in: dueIn }), pages });
        } catch (error) {
          return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
        }
      },
    },
    [NOTCH_SCRIPT_PATH]: {
      POST: async (req) => {
        const gate = notchDemoGate();
        const script = deps.script;
        if (!gate || !script || !notchDemoTokenMatches(req.headers.get(NOTCH_DEMO_HEADER), gate)) return notFound();
        const answer = notchScriptOp(await req.json().catch(() => null), script);
        return Response.json({ ...answer.body, pages: deps.pages?.() ?? 0 }, { status: answer.status });
      },
    },
  };
}
