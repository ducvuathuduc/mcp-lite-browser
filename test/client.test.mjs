import { test } from "node:test";
import assert from "node:assert/strict";
import { McpClient, McpHttpClient, McpError, SseParser, parseSse, bearer } from "../dist/index.js";

// A tiny fake Streamable HTTP server returning real `Response` objects (JSON or SSE).
function fakeServer({ sse = false, sessionId = "s-123", failOn, status, onRequest } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, msg });
    const custom = onRequest?.(init, msg, calls);
    if (custom) return custom;
    const headers = { "mcp-session-id": sessionId };
    if (status) return new Response("nope", { status, headers });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (init.method === "GET") return new Response(null, { status: 405 });
    if (msg.id === undefined || msg.method === undefined) return new Response(null, { status: 202, headers });
    if (failOn === msg.method) return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad params", data: { why: 1 } } }, { headers });
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "fake", version: "1" }, capabilities: { tools: {} } };
    if (msg.method === "tools/list") result = msg.params.cursor ? { tools: [{ name: "b", inputSchema: {} }] } : { tools: [{ name: "echo", inputSchema: { type: "object" } }], nextCursor: "p2" };
    if (msg.method === "tools/call") result = { content: [{ type: "text", text: msg.params.arguments.text }], structuredContent: { echoed: msg.params.arguments.text } };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    return sse
      ? new Response(`id: e1\ndata:\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}\n\nid: e2\nevent: message\ndata: ${payload}\n\n`, { headers: { ...headers, "content-type": "text/event-stream" } })
      : new Response(payload, { headers: { ...headers, "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("SseParser handles CRLF, multi-line data, ids, retry, comments and split chunks", () => {
  const events = [];
  const p = new SseParser((e) => events.push(e));
  for (const chunk of [": ping\r\n\r\nid: 7\r\nretry: 250\r\nda", "ta: {\"a\":\r\ndata: 1}\r", "\n\r\nevent: x\ndata: two\n\n"]) p.push(chunk);
  p.end();
  assert.deepEqual(events, [
    { event: "message", data: '{"a":\n1}', id: "7", retry: 250 },
    { event: "x", data: "two", id: undefined, retry: undefined },
  ]);
  assert.deepEqual(parseSse('data: {"b":2}\n\n: keep-alive\n\ndata: not json\n\n'), [{ b: 2 }]);
});

for (const sse of [false, true]) {
  test(`handshake, headers and tools over ${sse ? "SSE" : "JSON"} responses`, async () => {
    const { fetchImpl, calls } = fakeServer({ sse });
    const traffic = [];
    const c = new McpClient("http://x/mcp", { fetchImpl, onTraffic: (d, m, meta) => traffic.push([d, meta.via]) });
    const init = await c.connect();
    assert.equal(init.protocolVersion, "2025-11-25");
    assert.equal(c.sessionId, "s-123");
    assert.equal(calls[0].msg.params.capabilities.extensions["io.modelcontextprotocol/ui"].mimeTypes[0], "text/html;profile=mcp-app");
    assert.equal(calls[1].msg.method, "notifications/initialized");
    const r = await c.callTool("echo", { text: "hi" });
    assert.equal(r.structuredContent.echoed, "hi");
    const h = calls[2].init.headers;
    assert.equal(h["mcp-protocol-version"], "2025-11-25");
    assert.equal(h["mcp-session-id"], "s-123");
    assert.equal(h.accept, "application/json, text/event-stream");
    assert.ok(traffic.some(([d, via]) => d === "in" && via === (sse ? "post-sse" : "json")));
    await c.close();
    assert.equal(calls.at(-1).init.method, "DELETE");
  });
}

test("McpHttpClient is kept as an alias of McpClient", () => assert.equal(McpHttpClient, McpClient));

test("listAllTools follows nextCursor pagination", async () => {
  const { fetchImpl } = fakeServer();
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await c.connect();
  assert.deepEqual((await c.listAllTools()).map((t) => t.name), ["echo", "b"]);
});

test("JSON-RPC errors become McpError with code and data; HTTP errors carry the status", async () => {
  const { fetchImpl } = fakeServer({ failOn: "tools/call" });
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await c.connect();
  await assert.rejects(() => c.callTool("echo", {}), (e) => e instanceof McpError && e.code === -32602 && e.data.why === 1);
  const bad = new McpClient("http://x/mcp", fakeServer({ status: 500 }));
  await assert.rejects(() => bad.connect(), (e) => e.code === 500 && /HTTP 500/.test(e.message));
});

test("unsupported protocol version from the server is rejected", async () => {
  const { fetchImpl } = fakeServer({ onRequest: (init, msg) => msg?.method === "initialize" && Response.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "1999-01-01", capabilities: {}, serverInfo: { name: "old", version: "0" } } }) });
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await assert.rejects(() => c.connect(), /Unsupported protocol version/);
});

test("request ids increase monotonically", async () => {
  const { fetchImpl, calls } = fakeServer();
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await c.connect(); await c.listTools(); await c.listTools();
  assert.deepEqual(calls.filter((x) => x.msg?.id !== undefined).map((x) => x.msg.id), [1, 2, 3]);
});

test("static headers, header functions and bearer() auth are sent on every request", async () => {
  const { fetchImpl, calls } = fakeServer();
  const c = new McpClient("http://x/mcp", { fetchImpl, headers: () => ({ "x-team": "a" }), auth: bearer("t0k") });
  await c.connect();
  assert.equal(calls[0].init.headers.authorization, "Bearer t0k");
  assert.equal(calls[1].init.headers["x-team"], "a");
});

test("401 calls auth.onUnauthorized with the challenge and retries once", async () => {
  let token = null; const seen = [];
  const { fetchImpl, calls } = fakeServer({
    onRequest: (init) => !init.headers.authorization && new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://x/.well-known/oauth-protected-resource"' } }),
  });
  const auth = {
    headers: () => (token ? { authorization: `Bearer ${token}` } : {}),
    onUnauthorized: async (info) => { seen.push(info); token = "fresh"; return true; },
  };
  const c = new McpClient("http://x/mcp", { fetchImpl, auth });
  await c.connect();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].status, 401);
  assert.match(seen[0].wwwAuthenticate, /resource_metadata/);
  assert.equal(calls[1].init.headers.authorization, "Bearer fresh");
});

test("an already-aborted signal rejects without sending", async () => {
  const { fetchImpl, calls } = fakeServer();
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await c.connect();
  const n = calls.length;
  const ac = new AbortController(); ac.abort();
  await assert.rejects(() => c.listTools({}, { signal: ac.signal }), (e) => e.name === "AbortError");
  assert.equal(calls.length, n, "nothing was sent, not even notifications/cancelled");
});

test("server-to-client requests without a handler get -32601; ping is answered", async () => {
  const replies = [];
  const { fetchImpl } = fakeServer({
    onRequest: (init, msg) => {
      if (msg && msg.method === undefined) { replies.push(msg); return new Response(null, { status: 202 }); }
      if (msg?.method === "tools/list") {
        const body = [
          { jsonrpc: "2.0", id: "s1", method: "ping" },
          { jsonrpc: "2.0", id: "s2", method: "sampling/createMessage", params: {} },
          { jsonrpc: "2.0", id: msg.id, result: { tools: [] } },
        ].map((m) => `data: ${JSON.stringify(m)}\n\n`).join("");
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
    },
  });
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await c.connect();
  await c.listTools();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(replies.find((r) => r.id === "s1").result, {});
  assert.equal(replies.find((r) => r.id === "s2").error.code, -32601);
});

test("listen() resolves false when the server has no GET stream (405)", async () => {
  const { fetchImpl } = fakeServer();
  const c = new McpClient("http://x/mcp", { fetchImpl });
  await c.connect();
  assert.equal(await c.listen(), false);
});

test("capabilities are declared only for the handlers you provide", async () => {
  const { fetchImpl, calls } = fakeServer();
  const c = new McpClient("http://x/mcp", { fetchImpl, apps: false, onElicit: () => ({ action: "decline" }), roots: [] });
  await c.connect();
  assert.deepEqual(calls[0].msg.params.capabilities, { roots: { listChanged: true }, elicitation: { form: {}, url: {} } });
});
