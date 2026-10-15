import page from "./index.html";

// Local visual fixture. No daemon, credentials, database or provider needed.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4410),
  routes: { "/": page },
  fetch: () => new Response("Not found", { status: 404 }),
  development: true,
});
console.log(`ON-U-01 preview: ${server.url}`);
