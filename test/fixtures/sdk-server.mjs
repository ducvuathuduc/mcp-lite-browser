// A real MCP server built with the official TypeScript SDK (@modelcontextprotocol/sdk), stateful Streamable HTTP
// with an event store (resumability). Used by test/conformance.test.mjs and scripts/demo-server.mjs.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { z } from "zod";

export const APP_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{font:14px system-ui;margin:0;padding:14px;background:var(--color-background-primary,#fff);color:var(--color-text-primary,#111)}
.card{border:1px solid #d0d7de;border-radius:10px;padding:14px}.n{font-size:34px;font-weight:700}button{margin-top:10px;padding:6px 12px}
</style></head><body><div class="card"><div>Counter MCP App</div><div class="n" id="n">–</div><button id="b">+1 (tools/call from the view)</button></div>
<script>
let id=0;const wait={};const send=(method,params)=>{const i=++id;parent.postMessage({jsonrpc:"2.0",id:i,method,params},"*");return new Promise(r=>wait[i]=r)};
addEventListener("message",e=>{const m=e.data;if(m&&m.id&&wait[m.id]){wait[m.id](m);delete wait[m.id]}
 if(m&&m.method==="ui/notifications/tool-result"){document.getElementById("n").textContent=m.params.structuredContent.count}});
document.getElementById("b").onclick=async()=>{const r=await send("tools/call",{name:"counter_increment",arguments:{}});document.getElementById("n").textContent=r.result.structuredContent.count};
send("ui/initialize",{protocolVersion:"2026-01-26",appInfo:{name:"counter",version:"1"},appCapabilities:{}}).then(()=>{parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/initialized"},"*");
 parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:document.body.scrollHeight}},"*")});
</script></body></html>`;

function buildServer(state, transports) {
  const server = new McpServer({ name: "sdk-conformance-server", version: "1.0.0" }, { capabilities: { logging: {} } });
  let count = 0;

  server.registerTool("echo", { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }], structuredContent: { echoed: text } }));

  server.registerTool("slow", { description: "Reports progress, honours cancellation", inputSchema: { steps: z.number(), ms: z.number() } },
    async ({ steps, ms }, extra) => {
      for (let i = 1; i <= steps; i++) {
        if (extra.signal.aborted) { state.cancelled.push(extra.requestId); return { content: [{ type: "text", text: "cancelled" }] }; }
        await new Promise((r) => setTimeout(r, ms));
        const token = extra._meta?.progressToken;
        if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: i, total: steps, message: `step ${i}` } });
      }
      if (extra.signal.aborted) state.cancelled.push(extra.requestId);
      return { content: [{ type: "text", text: `done ${steps}` }] };
    });

  server.registerTool("ask_name", { description: "Elicits the user's name (request sent on the POST stream)" }, async (extra) => {
    const r = await server.server.elicitInput({ mode: "form", message: "What is your name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } }, { relatedRequestId: extra.requestId });
    return { content: [{ type: "text", text: r.action === "accept" ? `Hello ${r.content.name}` : r.action }] };
  });

  server.registerTool("summarize", { description: "Uses sampling (request sent on the POST stream)" }, async (extra) => {
    const r = await server.server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "Say hi" } }], maxTokens: 20 }, { relatedRequestId: extra.requestId });
    return { content: [{ type: "text", text: `model said: ${r.content.text} (${r.model})` }] };
  });

  server.registerTool("summarize_unrelated", { description: "Uses sampling (request sent on the standalone GET stream)" }, async () => {
    const r = await server.server.createMessage({ messages: [{ role: "user", content: { type: "text", text: "Say hi" } }], maxTokens: 20 });
    return { content: [{ type: "text", text: `model said: ${r.content.text} (${r.model})` }] };
  });

  server.registerTool("list_roots", { description: "Lists client roots" }, async (extra) => {
    const r = await server.server.listRoots(undefined, { relatedRequestId: extra.requestId });
    return { content: [{ type: "text", text: r.roots.map((x) => x.uri).join(",") }] };
  });

  server.registerTool("drop_stream", { description: "Closes the SSE connection mid-request; the client must resume" },
    async (extra) => {
      const token = extra._meta?.progressToken;
      if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
      transports[extra.sessionId].closeSSEStream(extra.requestId);
      await new Promise((r) => setTimeout(r, 150));
      if (token !== undefined) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: 2, total: 2 } });
      return { content: [{ type: "text", text: "survived a dropped stream" }] };
    });

  server.registerTool("add_tool", { description: "Registers a new tool (tools/list_changed)" }, async () => {
    server.registerTool("added_later", { description: "Appeared at runtime" }, async () => ({ content: [{ type: "text", text: "hi" }] }));
    return { content: [{ type: "text", text: "added" }] };
  });

  server.registerTool("log", { description: "Emits a log notification" }, async (extra) => {
    await extra.sendNotification({ method: "notifications/message", params: { level: "info", data: "hello from the server" } });
    return { content: [{ type: "text", text: "logged" }] };
  });

  server.registerTool("counter", {
    description: "Shows a counter as an MCP App",
    _meta: { ui: { resourceUri: "ui://counter/app.html" } },
  }, async () => ({ content: [{ type: "text", text: `count=${count}` }], structuredContent: { count } }));

  server.registerTool("counter_increment", {
    description: "App-only: increments the counter",
    _meta: { ui: { resourceUri: "ui://counter/app.html", visibility: ["app"] } },
  }, async () => { count++; return { content: [{ type: "text", text: `count=${count}` }], structuredContent: { count } }; });

  server.registerResource("counter-app", "ui://counter/app.html", { mimeType: "text/html;profile=mcp-app" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: APP_HTML, _meta: { ui: { prefersBorder: true, csp: { connectDomains: [] } } } }] }));

  server.registerResource("readme", "file:///readme.md", { mimeType: "text/markdown", description: "A text resource" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# Hello" }] }));

  server.registerPrompt("greet", { description: "Greets someone", argsSchema: { name: z.string() } },
    ({ name }) => ({ messages: [{ role: "user", content: { type: "text", text: `Say hello to ${name}` } }] }));

  return server;
}

/** Start the server on a random localhost port. */
export async function startSdkServer({ cors = false } = {}) {
  const transports = {};
  const state = { cancelled: [], deleted: [], transports };
  const httpServer = http.createServer(async (req, res) => {
    if (cors) {
      res.setHeader("access-control-allow-origin", "*");
      res.setHeader("access-control-allow-headers", "*");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("access-control-expose-headers", "mcp-session-id, www-authenticate");
      if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    }
    const sid = req.headers["mcp-session-id"];
    try {
      if (sid && transports[sid]) {
        if (req.method === "DELETE") state.deleted.push(sid);
        await transports[sid].handleRequest(req, res);
        return;
      }
      if (sid) { res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })); return; }
      if (req.method !== "POST") { res.writeHead(400).end(); return; }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        eventStore: new InMemoryEventStore(),
        retryInterval: 50,
        onsessioninitialized: (id) => { transports[id] = transport; },
      });
      transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
      await buildServer(state, transports).connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500).end(String(e));
    }
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const { port } = httpServer.address();
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    state,
    /** Forget every session (the next request with an old id gets 404). */
    expireSessions() { for (const k of Object.keys(transports)) delete transports[k]; },
    async close() {
      for (const t of Object.values(transports)) await t.close().catch(() => {});
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(r));
    },
  };
}
