import page from "./index.html";
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4414),
  routes: { "/": page }, fetch: () => new Response("Not found", { status: 404 }), development: true });
console.log(`ON-U-05 preview: ${server.url}`);
