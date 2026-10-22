/**
 * The only service worker script this daemon ever serves.
 *
 * The dashboard registers no service worker of its own, but its origin also
 * serves site previews (agent-authored code), and before the site proxy
 * refused it, a preview could register a root-scoped worker that controls
 * every dashboard page long after the preview closed. A 403 on the browser's
 * update check does not evict such a worker: the update just fails and the
 * old registration stays active (measured in Chromium 154). Answering every
 * `Service-Worker: script` fetch with this script replaces it on its next
 * update check, and the replacement unregisters itself. A new registration
 * attempt gets the same script and removes itself the same way.
 *
 * Service-Worker-Allowed: / is what lets it replace a ROOT-scoped worker whose
 * script lives below the root (a preview at /api/sites/<id>/proxy/ could
 * register its sw.js with scope / while the proxy still passed the dev
 * server's own Service-Worker-Allowed through). The browser recomputes the
 * max scope from each update response; without the header the update fails
 * with a SecurityError and the old worker stays (measured in Chromium 154).
 * The header is safe here because this script only removes itself and the
 * caches a worker may have left behind (the dashboard uses no Cache Storage).
 */

const KILL_SWITCH_SOURCE = [
  "self.addEventListener('install', () => self.skipWaiting());",
  "self.addEventListener('activate', (event) => event.waitUntil(Promise.all([",
  "  self.registration.unregister(),",
  "  caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))),",
  "])));",
].join('\n');

export function isServiceWorkerScriptRequest(req: Request): boolean {
  return req.headers.get('service-worker') === 'script';
}

export function serviceWorkerKillSwitch(): Response {
  return new Response(KILL_SWITCH_SOURCE, {
    status: 200,
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
      'Service-Worker-Allowed': '/',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
