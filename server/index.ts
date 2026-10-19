import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.ts";
import { recoverOrphans } from "./runs.ts";
import { recoverChats } from "./chat.ts";

// Built dashboard (npm run build). In dev, Vite serves it and proxies /api here.
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

recoverOrphans();
recoverChats();

// Loopback only by default: anyone who reaches the API can point a workspace at a repo here and spend the provider keys.
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (a) => console.log(`api on http://${hostname}:${a.port}`));
