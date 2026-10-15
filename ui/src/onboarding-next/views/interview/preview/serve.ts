import page from "./index.html";
// Isolated UI fixture. No model, socket, account or persistence services.
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4413),
  routes: { "/": page }, fetch: () => new Response("Not found", { status: 404 }), development: true });
console.log(`ON-U-04 preview: ${server.url}`);
