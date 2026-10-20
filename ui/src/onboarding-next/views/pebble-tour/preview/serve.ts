import { buildPreview } from "./build";

const build = await buildPreview();
if (!build.success) { console.error(build.logs); process.exit(1); }
console.log("ON-U-06 preview build passed. Shell: ui/src/brief (current tree).");
if (!process.argv.includes("--build")) {
  const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jarvis · Pebble tutorial</title><link href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:ital,wght@0,400..700;1,400&family=Spline+Sans+Mono:wght@400;500;600&display=swap" rel="stylesheet"><link rel="stylesheet" href="/preview.css"></head><body><div id="root"></div><script type="module" src="/preview.js"></script></body></html>';
  const assets = new Map(build.outputs.map(asset => ["/" + asset.path.replace(/^\.\//, ""), asset]));
  const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.ONBOARDING_PREVIEW_PORT ?? 4415), fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
    const asset = assets.get(path);
    return asset ? new Response(asset) : new Response("Not found", { status: 404 });
  } });
  console.log(`ON-U-06 preview: ${server.url}`);
}
