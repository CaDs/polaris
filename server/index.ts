import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "./app.ts";
import { recoverOrphans } from "./runs.ts";
import { ownCheckoutProjects } from "./tracker.ts";
import { recoverChats } from "./chat.ts";

// Certificate checks are what keep provider keys and OAuth tokens going to the real endpoint, for every call this process
// makes. A private CA belongs in NODE_EXTRA_CA_CERTS, not in turning the checks off.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" && process.env.POLARIS_ALLOW_INSECURE_TLS !== "1") {
  console.error("NODE_TLS_REJECT_UNAUTHORIZED=0 turns off TLS certificate checks, so provider keys could be sent to an impostor. Unset it (for a private CA set NODE_EXTRA_CA_CERTS=/path/ca.pem), or set POLARIS_ALLOW_INSECURE_TLS=1 to run anyway.");
  process.exit(1);
}

// Built dashboard (npm run build). In dev, Vite serves it and proxies /api here.
app.use("/*", serveStatic({ root: "./dist" }));
app.get("*", serveStatic({ path: "./dist/index.html" }));

recoverOrphans();
recoverChats();

// Under `node --watch` the child process sees no --watch flag, only this variable.
if (process.execArgv.some((a) => a.startsWith("--watch")) || "WATCH_REPORT_DEPENDENCIES" in process.env)
  for (const p of ownCheckoutProjects())
    console.warn(`Project ${p.key} builds the checkout this server runs from with --watch: a merge or edit there restarts the server and fails every running run. Run the instance from its own clone (README: Working on Polaris with Polaris).`);

// Loopback only by default: anyone who reaches the API can point a workspace at a repo here and spend the provider keys.
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";
serve({ fetch: app.fetch, port, hostname }, (a) => console.log(`api on http://${hostname}:${a.port}`));
