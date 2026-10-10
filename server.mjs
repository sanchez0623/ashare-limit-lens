import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { localDatabase } from "./scripts/local-db.mjs";
import { startTradingRunner } from "./scripts/trading-runner.mjs";
import worker from "./dist/server/index.js";
try {
  process.loadEnvFile();
} catch {}
const host = process.env.HOST || "127.0.0.1",
  port = Number(process.env.PORT || 3000);
const authUser = process.env.AUTH_USER || "",
  authPassword = process.env.AUTH_PASSWORD || "";
if (
  (host !== "127.0.0.1" || authUser || authPassword) &&
  (!authUser || authPassword.length < 16)
)
  throw new Error("对外监听必须设置 AUTH_USER 和至少 16 位 AUTH_PASSWORD");
const dbPath = process.env.LOCAL_DATABASE_PATH || ".sites-runtime/local.sqlite";
mkdirSync(dirname(dbPath), { recursive: true });
const DB = localDatabase(dbPath),
  env = {
    DB,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_MODEL: process.env.AI_MODEL,
    LOCAL_RESEARCH_DB_PATH: process.env.LOCAL_RESEARCH_DB_PATH,
    TRADING_POLL_SECONDS: process.env.TRADING_POLL_SECONDS || "10",
    TRADING_RUNNER:
      process.env.TRADING_ENABLED === "false" ? "disabled" : "server",
  };
const hash = (value) => createHash("sha256").update(value).digest();
const authorized = (req) => {
  if (!authUser && !authPassword && host === "127.0.0.1") return true;
  const expected = `Basic ${Buffer.from(`${authUser}:${authPassword}`).toString("base64")}`;
  return timingSafeEqual(hash(req.headers.authorization || ""), hash(expected));
};
const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Limit Lens", charset="UTF-8"',
      "Cache-Control": "no-store",
    });
    res.end("Authentication required");
    return;
  }
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
    const origin =
      process.env.PUBLIC_ORIGIN ||
      `http://${req.headers.host || `localhost:${port}`}`;
    const request = new Request(new URL(req.url, origin), {
      method: req.method,
      headers: req.headers,
      ...(["GET", "HEAD"].includes(req.method)
        ? {}
        : { body: Buffer.concat(chunks) }),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end("Service error");
  }
});
let runner;
server.listen(port, host, () => {
  console.log(`Trading server listening on port ${port}`);
  if (process.env.TRADING_ENABLED !== "false")
    runner = startTradingRunner(env, async () =>
      (
        await worker.fetch(
          new Request("http://localhost/api/run-daily", { method: "POST" }),
          env,
        )
      ).json(),
    );
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    runner?.stop();
    server.close(() => {
      DB.close();
      process.exit(0);
    });
  });
