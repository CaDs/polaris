import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.ts";
import { recoverOrphans } from "./runs.ts";

// Built dashboard (npm run build). In dev, Vite serves it and proxies /api here.
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

recoverOrphans();

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`api on http://localhost:${port}`));
