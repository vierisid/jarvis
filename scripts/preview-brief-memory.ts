/** D25 static fixture preview. No daemon, user database, credentials, or API proxy. */
import { resolve, sep } from "node:path";
const roots = [
  resolve(import.meta.dir, "../ui/dist"),
  resolve(import.meta.dir, "../ui/public"),
];
const port = Number(process.env.D25_PREVIEW_PORT ?? 4415);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, { status: 405 });
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (path.startsWith("/api/"))
      return new Response("Fixture preview has no API", { status: 501 });
    for (const root of roots) {
      const filePath = resolve(root, `.${path === "/" ? "/index.html" : path}`);
      if (!filePath.startsWith(`${root}${sep}`))
        return new Response(null, { status: 404 });
      const file = Bun.file(filePath);
      if (await file.exists())
        return new Response(request.method === "HEAD" ? null : file, {
          headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
        });
    }
    return new Response(null, { status: 404 });
  },
});
console.log(
  `D25 fixture: ${server.url}?brief=preview&specimen=memory#/_brief_preview`,
);
