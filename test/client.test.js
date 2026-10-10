import { test } from "node:test";
import assert from "node:assert/strict";
import { McpHttpClient, McpError, parseSse } from "../src/index.js";

// A tiny fake Streamable HTTP server: answers with JSON or SSE, issues a session id.
function fakeServer({ sse = false, sessionId = "s-123", failOn } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const msg = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, msg });
    const headers = new Map([["mcp-session-id", sessionId]]);
    const res = (status, body, type) => ({
      status, ok: status < 400,
      headers: { get: (k) => (k === "content-type" ? type : headers.get(k)) },
      text: async () => body,
    });
    if (init.method === "DELETE") return res(204, "", "");
    if (msg.id === undefined) return res(202, "", "");
    if (failOn === msg.method) return res(200, JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad params" } }), "application/json");
    let result = {};
    if (msg.method === "initialize") result = { protocolVersion: msg.params.protocolVersion, serverInfo: { name: "fake", version: "1" }, capabilities: { tools: {} } };
    if (msg.method === "tools/list") result = { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    if (msg.method === "tools/call") result = { content: [{ type: "text", text: msg.params.arguments.text }], structuredContent: { echoed: msg.params.arguments.text } };
    const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    return sse
      ? res(200, `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: ${payload}\n\n`, "text/event-stream")
      : res(200, payload, "application/json");
  };
  return { fetchImpl, calls };
}

test("parseSse extracts JSON-RPC messages and ignores keep-alives", () => {
  const msgs = parseSse(': ping\n\nevent: message\ndata: {"a":1}\n\ndata: {"b":\ndata: 2}\n\n');
  assert.deepEqual(msgs, [{ a: 1 }, { b: 2 }]);
});

for (const sse of [false, true]) {
  test(`handshake + tools over ${sse ? "SSE" : "JSON"} responses`, async () => {
    const { fetchImpl, calls } = fakeServer({ sse });
    const traffic = [];
    const c = new McpHttpClient("http://x/mcp", { fetchImpl, onTraffic: (d, m) => traffic.push(d) });
    const init = await c.connect();
    assert.equal(init.protocolVersion, "2025-11-25");
    assert.equal(c.negotiatedVersion, "2025-11-25");
    assert.equal(c.sessionId, "s-123");
    assert.equal(calls[1].msg.method, "notifications/initialized");
    const { tools } = await c.listTools();
    assert.equal(tools[0].name, "echo");
    // Follow-up requests carry protocol version and session headers.
    assert.equal(calls[2].init.headers["mcp-protocol-version"], "2025-11-25");
    assert.equal(calls[2].init.headers["mcp-session-id"], "s-123");
    assert.match(calls[2].init.headers.accept, /text\/event-stream/);
    const r = await c.callTool("echo", { text: "hi" });
    assert.equal(r.structuredContent.echoed, "hi");
    assert.ok(traffic.includes("out") && traffic.includes("in"));
    await c.close();
    assert.equal(calls.at(-1).init.method, "DELETE");
  });
}

test("JSON-RPC errors become McpError with code", async () => {
  const { fetchImpl } = fakeServer({ failOn: "tools/call" });
  const c = new McpHttpClient("http://x/mcp", { fetchImpl });
  await c.connect();
  await assert.rejects(() => c.callTool("echo", {}), (e) => e instanceof McpError && e.code === -32602);
});

test("request ids increase monotonically", async () => {
  const { fetchImpl, calls } = fakeServer();
  const c = new McpHttpClient("http://x/mcp", { fetchImpl });
  await c.connect(); await c.listTools(); await c.listTools();
  const ids = calls.filter((x) => x.msg && x.msg.id !== undefined).map((x) => x.msg.id);
  assert.deepEqual(ids, [1, 2, 3]);
});
