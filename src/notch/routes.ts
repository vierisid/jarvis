/**
 * The notch's page and its one route.
 *
 * The page is a built file, ui/notch.html, served like every other page of
 * the dashboard: from the static directory, behind the session check. It is
 * inert by itself: it draws nothing until the brain answers its hello, and a
 * brain with the switch off never does.
 *
 * The route is the demo endpoint, which exists only with the switch on and its
 * own gate open (./demo-gate.ts).
 */
import { NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH, notchDemoGate, notchDemoTokenMatches } from './demo-gate.ts';

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
  };
}
