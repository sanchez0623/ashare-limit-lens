import { ASSETS } from "../.sites-runtime/assets.js";
import { api } from "./routes/api.js";
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api(request, env);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405 });
    const asset = ASSETS[path === "/index.html" ? "/" : path];
    if (!asset) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : asset.body, {
      headers: {
        "Content-Type": asset.type,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
      },
    });
  },
};
