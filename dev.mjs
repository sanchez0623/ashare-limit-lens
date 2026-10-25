import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localDatabase } from "./scripts/local-db.mjs";
import { startDataUpdateWorker } from "./scripts/data-worker-supervisor.mjs";
import worker from "./dist/server/index.js";
try {
  process.loadEnvFile();
} catch {}
mkdirSync(".sites-runtime", { recursive: true });
const dbPath = process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const DB = localDatabase(dbPath);
const dataEnabled = process.env.DATA_WORKER_ENABLED !== "false";
let dataWorker;
const port = Number(process.env.PORT || 3000);
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 12000) {
        res.writeHead(413);
        res.end("Request too large");
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const request = new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: req.headers,
      ...(["GET", "HEAD"].includes(req.method) ? {} : { body }),
    });
    const response = await worker.fetch(request, {
      DB,
      DATA_UPDATE_RUNNER: dataEnabled ? "local" : "disabled",
      SW_METADATA_SOURCE: process.env.SW_METADATA_SOURCE || "lixinger",
      LIXINGER_CONFIGURED: !!process.env.LIXINGER_TOKEN?.trim(),
      AI_API_KEY: process.env.AI_API_KEY,
      AI_BASE_URL: process.env.AI_BASE_URL,
      AI_MODEL: process.env.AI_MODEL,
      LOCAL_RESEARCH_DB_PATH: process.env.LOCAL_RESEARCH_DB_PATH,
      QUAN_DATA_DIR: process.env.QUAN_DATA_DIR,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("Local server error");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Local: http://localhost:${port}`);
  dataWorker = startDataUpdateWorker(dbPath, { enabled: dataEnabled });
});
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await dataWorker?.stop();
    server.close(() => {
      DB.close();
      process.exit(0);
    });
  });
