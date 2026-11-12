/**
 * The page the notch shows.
 *
 * For now it is the window test page: a black shape with three sizes and a text
 * box, used to prove the window before the real notch is built on it. It is
 * served under /api so it goes through the same session check as every other
 * authenticated route, and it does not exist at all unless the switch is on.
 */
import path from 'node:path';

/** Where the desktop app is told to point the notch's window. */
export const NOTCH_PAGE_PATH = '/api/notch/spike';

const SPIKE_PAGE = await Bun.file(path.join(import.meta.dir, 'spike.html')).text();

type NotchRoutes = Record<string, { GET: (req: Request) => Response }>;

export function notchRoutes(enabled: boolean): NotchRoutes {
  // Off: no route. A request for the page gets the ordinary 404.
  if (!enabled) return {};
  return {
    [NOTCH_PAGE_PATH]: {
      GET: () => new Response(SPIKE_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      }),
    },
  };
}
