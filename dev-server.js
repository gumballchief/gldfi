/**
 * Local dev server: serves the static site AND the /api routes together, so the
 * full pipeline (chain -> keeper -> API -> page) can be exercised end to end
 * without deploying. Vercel does this in production; this is the local stand-in.
 *
 *   RPC_URL=http://127.0.0.1:8545 \
 *   DISTRIBUTOR_ADDRESS=0x... TREASURY_ADDRESS=0x... \
 *   node dev-server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8782);
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const routes = {
  "/api/stats": require("./api/stats"),
  "/api/distributions": require("./api/distributions"),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  const handler = routes[url.pathname];
  if (handler) {
    // Shim the two Vercel response helpers the handlers use.
    res.status = (c) => { res.statusCode = c; return res; };
    try {
      await handler(req, res);
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}`);
  console.log(`  RPC_URL=${process.env.RPC_URL || "(unset -> API returns deployed:false)"}`);
});
