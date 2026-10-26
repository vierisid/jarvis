/** Isolated D33 browser fixture. No daemon, API proxy, credentials or database. */
import page from "./index.html";
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.D33_PREVIEW_PORT ?? 4433),
  routes: { "/": page },
  fetch: () => new Response("No API in the isolated release-switch fixture", { status: 404 }),
});
console.log(`D33 synthetic release-switch fixture: ${server.url}`);
