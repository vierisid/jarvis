import page from "./index.html";
// Isolated local fixture. No daemon, provider, credentials or workflow execution.
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4429),
  routes: { "/": page }, fetch: () => new Response("Not found", { status: 404 }), development: true });
console.log("ON-U-09 preview: " + server.url);
