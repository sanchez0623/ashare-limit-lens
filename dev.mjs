import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { localDatabase } from "./scripts/local-db.mjs";
import worker from "./dist/server/index.js";
try {
  process.loadEnvFile();
} catch {}
mkdirSync(".sites-runtime", { recursive: true });
const DB = localDatabase(
  process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite",
);
const port = Number(process.env.PORT || 3000);
createServer(async (req, res) => {
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
      AI_API_KEY: process.env.AI_API_KEY,
      AI_BASE_URL: process.env.AI_BASE_URL,
      AI_MODEL: process.env.AI_MODEL,
      LOCAL_RESEARCH_DB_PATH: process.env.LOCAL_RESEARCH_DB_PATH,
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("Local server error");
  }
}).listen(port, "127.0.0.1", () =>
  console.log(`Local: http://localhost:${port}`),
);
