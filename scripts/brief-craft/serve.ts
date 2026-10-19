/** Loopback, read-only static server over the built UI for the Brief fixture preview and the D32
 * craft runner. No daemon, user database, credentials, API proxy or network access from the page.
 * Build first with `bun run build:ui`. */
import { resolve, sep } from "node:path";

const roots = [resolve(import.meta.dir, "../../ui/dist"), resolve(import.meta.dir, "../../ui/public")];
const port = Number(process.env.BRIEF_CRAFT_PORT ?? 4422);
// The page may not open any connection. Scripts stay unrestricted because index.html carries an
// inline theme bootstrap that the preview must run like the real dashboard.
const csp = "connect-src 'none'; object-src 'none'; base-uri 'none'";

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Read-only fixture preview", { status: 405 });
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (path.startsWith("/api/")) return new Response("Fixture preview has no API", { status: 501 });
    for (const root of roots) {
      const file = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      if (!file.startsWith(root + sep)) return new Response(null, { status: 404 });
      const body = Bun.file(file);
      if (await body.exists()) {
        return new Response(request.method === "HEAD" ? null : body, {
          headers: { "Content-Type": body.type, "Cache-Control": "no-store", "Content-Security-Policy": csp },
        });
      }
    }
    return new Response(null, { status: 404 });
  },
});

console.log(`Brief fixture preview: ${server.url}?brief=preview&specimen=billing&craft=1#/_brief_preview`);
