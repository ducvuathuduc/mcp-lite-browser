// Local dev: serves the playground (with dist/ mounted at /lib) and a real MCP server built with the
// official SDK at /mcp (CORS enabled), so you can try the playground against an actual HTTP server.
//   npm run build && npm run playground   → http://localhost:5173/?url=http://localhost:5173/mcp
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { startSdkServer } from "../test/fixtures/sdk-server.mjs";

const PORT = +process.env.PORT || 5173;
const mcp = await startSdkServer({ cors: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mcp") {
    // Proxy to the SDK server so the page and the MCP endpoint share an origin.
    const body = await new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))); });
    const upstream = await fetch(mcp.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== "host")), body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : body, duplex: "half" });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  }
  const rel = url.pathname.startsWith("/lib/") ? join("dist", url.pathname.slice(5)) : join("playground", url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const file = normalize(rel);
    if (file.includes("..")) throw new Error("bad path");
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" }).end(await readFile(file));
  } catch { res.writeHead(404).end("not found"); }
}).listen(PORT, () => console.log(`Playground: http://localhost:${PORT}/?url=http://localhost:${PORT}/mcp  (or click the demo button)`));
