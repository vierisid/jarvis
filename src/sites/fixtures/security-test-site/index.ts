import index from "./index.html";

const port = parseInt(process.env.BUN_PORT || "3000", 10);

Bun.serve({
  port,
  routes: {
    "/": index,
  },
  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Security test site running on http://localhost:${port}`);
