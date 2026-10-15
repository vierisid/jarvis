import page from "./index.html";

// Development-only fixture. No daemon, database, credentials or provider.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4411),
  routes: { "/": page },
  fetch: () => new Response("Not found", { status: 404 }),
  development: true,
});
console.log(`ON-U-02 preview: ${server.url}`);
