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
import { NOTCH_DEMO_HEADER, NOTCH_DEMO_PATH, NOTCH_FIXTURE_PATH, NOTCH_SCRIPT_PATH, NOTCH_STUDY_PATH, notchDemoGate, notchDemoTokenMatches } from './demo-gate.ts';
import { notchStudyOp, type NotchStudyDeps } from './mail/study-route.ts';
import { NOTCH_DROP_MAX_BYTES, type NotchDropped } from './drop.ts';
import { notchScriptOp } from './script.ts';
import type { NotchScriptDeps } from './script.ts';

/** Where the desktop app is told to point the notch's window. */
export const NOTCH_PAGE_PATH = '/notch.html';

/**
 * Where the notch's page sends a file that was dropped on it
 * (ui/src/notch/drop.ts). Like every route under /api it answers only a
 * signed-in page of this brain, from this brain's own origin.
 */
export const NOTCH_DROP_PATH = '/api/notch/drop';

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
  /** The mail study, run on a development brain (./mail/study-route.ts). */
  study?: NotchStudyDeps | null;
  /** How many notch pages are up and listening. */
  pages?: () => number;
  /** A file was dropped on the notch (./drop.ts). */
  drop?: ((dropped: NotchDropped) => { taken: boolean }) | null;
}

/** What a dropped file's request says about it: its name, its size as the page saw it, and how many came with it. */
export async function readNotchDrop(req: Request): Promise<NotchDropped> {
  let name = '';
  try { name = decodeURIComponent(req.headers.get('x-notch-file') ?? ''); } catch { name = ''; }
  const count = Number(req.headers.get('x-notch-count') ?? 1);
  const said = Number(req.headers.get('x-notch-size') ?? NaN);
  const length = Number(req.headers.get('content-length') ?? 0);
  let bytes = new Uint8Array(0);
  // A body larger than anything that could be read is not read at all.
  if (!(length > NOTCH_DROP_MAX_BYTES + 4096)) {
    try { bytes = new Uint8Array(await req.arrayBuffer()); } catch { bytes = new Uint8Array(0); }
    if (bytes.length > NOTCH_DROP_MAX_BYTES) bytes = new Uint8Array(0);
  }
  return {
    name,
    mediaType: (req.headers.get('content-type') ?? '').slice(0, 120),
    size: Number.isFinite(said) && said >= 0 ? said : bytes.length,
    bytes,
    count: Number.isInteger(count) && count > 0 ? Math.min(count, 999) : 1,
  };
}

type NotchRoutes = Record<string, { POST: (req: Request) => Promise<Response> }>;

const notFound = (): Response => Response.json({ error: 'Not found' }, { status: 404 });

export function notchRoutes(enabled: boolean, deps: NotchRouteDeps = {}): NotchRoutes {
  // Off: no route. A request gets the ordinary 404.
  if (!enabled) return {};
  return {
    [NOTCH_DROP_PATH]: {
      POST: async (req) => {
        const drop = deps.drop;
        if (!drop) return notFound();
        return Response.json(drop(await readNotchDrop(req)));
      },
    },
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
    [NOTCH_STUDY_PATH]: {
      POST: async (req) => {
        const gate = notchDemoGate();
        const study = deps.study;
        if (!gate || !study || !notchDemoTokenMatches(req.headers.get(NOTCH_DEMO_HEADER), gate)) return notFound();
        const answer = await notchStudyOp(await req.json().catch(() => null), study);
        return Response.json(answer.body, { status: answer.status });
      },
    },
  };
}
