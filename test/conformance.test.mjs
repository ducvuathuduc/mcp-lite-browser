// End-to-end tests against a real server built with the official MCP TypeScript SDK over real HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { McpClient, McpError, getUiResourceUri, isModelVisible } from "../dist/index.js";
import { startSdkServer } from "./fixtures/sdk-server.mjs";

let srv;
before(async () => { srv = await startSdkServer(); });
after(async () => { await srv.close(); });

const newClient = (opts = {}) => new McpClient(srv.url, { timeout: 5000, reconnectDelay: 50, ...opts });

test("initialize negotiates 2025-11-25 and gets a session id", async () => {
  const c = newClient();
  const init = await c.connect();
  assert.equal(init.protocolVersion, "2025-11-25");
  assert.equal(c.negotiatedVersion, "2025-11-25");
  assert.equal(init.serverInfo.name, "sdk-conformance-server");
  assert.match(c.sessionId, /^[0-9a-f-]{36}$/);
  await c.close();
});

test("older protocol versions are negotiated too (2025-03-26)", async () => {
  const c = newClient({ protocolVersion: "2025-03-26" });
  await c.connect();
  assert.equal(c.negotiatedVersion, "2025-03-26");
  await c.close();
});

test("tools, structured content, resources, prompts and ping", async () => {
  const c = newClient();
  await c.connect();
  const tools = await c.listAllTools();
  assert.ok(tools.some((t) => t.name === "echo"));
  const r = await c.callTool("echo", { text: "hi" });
  assert.deepEqual(r.structuredContent, { echoed: "hi" });
  const { resources } = await c.listResources();
  assert.ok(resources.some((x) => x.uri === "file:///readme.md"));
  const read = await c.readResource("file:///readme.md");
  assert.equal(read.contents[0].text, "# Hello");
  const p = await c.getPrompt("greet", { name: "Lan" });
  assert.match(p.messages[0].content.text, /Lan/);
  assert.deepEqual(await c.ping(), {});
  await c.close();
});

test("invalid tool arguments come back as isError results; unknown methods as McpError", async () => {
  const c = newClient();
  await c.connect();
  const bad = await c.callTool("echo", { text: 42 });
  assert.equal(bad.isError, true);
  await assert.rejects(() => c.request("no/such-method"), (e) => e instanceof McpError && e.code === -32601);
  await c.close();
});

test("progress notifications stream in while the tool runs", async () => {
  const c = newClient();
  await c.connect();
  const seen = [];
  const r = await c.callTool("slow", { steps: 3, ms: 20 }, { onProgress: (p) => seen.push(p.progress) });
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(r.content[0].text, "done 3");
  await c.close();
});

test("AbortSignal cancels the request and the server sees notifications/cancelled", async () => {
  const c = newClient();
  await c.connect();
  const ac = new AbortController();
  const p = c.callTool("slow", { steps: 20, ms: 25 }, { signal: ac.signal });
  setTimeout(() => ac.abort(new Error("user pressed stop")), 60);
  await assert.rejects(p, /user pressed stop/);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(srv.state.cancelled.length >= 1, true, "server-side signal was aborted");
  await c.close();
});

test("timeouts reject with -32001 and cancel server-side", async () => {
  const c = newClient();
  await c.connect();
  const before = srv.state.cancelled.length;
  await assert.rejects(() => c.callTool("slow", { steps: 20, ms: 25 }, { timeout: 60 }), (e) => e.code === -32001);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(srv.state.cancelled.length > before);
  await c.close();
});

test("elicitation: the server asks the user a question mid-tool-call", async () => {
  let asked;
  const c = newClient({ onElicit: (params) => { asked = params; return { action: "accept", content: { name: "Lan" } }; } });
  const init = await c.connect();
  assert.ok(init);
  const r = await c.callTool("ask_name");
  assert.equal(asked.message, "What is your name?");
  assert.equal(r.content[0].text, "Hello Lan");
  await c.close();
});

test("sampling: the server asks the client's model for a completion", async () => {
  const c = newClient({ onSampling: (p) => ({ role: "assistant", content: { type: "text", text: `hi (${p.maxTokens})` }, model: "test-model" }) });
  await c.connect();
  const r = await c.callTool("summarize");
  assert.equal(r.content[0].text, "model said: hi (20) (test-model)");
  await c.close();
});

test("sampling over the standalone GET stream (listen: true)", async () => {
  const c = newClient({ listen: true, onSampling: () => ({ role: "assistant", content: { type: "text", text: "pong" }, model: "m" }) });
  await c.connect();
  await new Promise((r) => setTimeout(r, 50));
  const r = await c.callTool("summarize_unrelated");
  assert.equal(r.content[0].text, "model said: pong (m)");
  await c.close();
});

test("roots: the server lists the client's roots", async () => {
  const c = newClient({ roots: [{ uri: "file:///home/lan/project", name: "project" }] });
  await c.connect();
  const r = await c.callTool("list_roots");
  assert.equal(r.content[0].text, "file:///home/lan/project");
  await c.close();
});

test("resumability: a dropped POST stream is resumed with GET + Last-Event-ID", async () => {
  const vias = [];
  const c = newClient({ onTraffic: (dir, msg, meta) => { if (dir === "in" && msg.result?.content) vias.push(meta.via); } });
  await c.connect();
  const progress = [];
  const r = await c.callTool("drop_stream", {}, { onProgress: (p) => progress.push(p.progress) });
  assert.equal(r.content[0].text, "survived a dropped stream");
  assert.deepEqual(progress, [1, 2]);
  assert.deepEqual(vias, ["resume"], "the result arrived on the resumed GET stream");
  await c.close();
});

test("listen(): standalone GET stream delivers list_changed and log notifications", async () => {
  const c = newClient();
  await c.connect();
  assert.equal(await c.listen(), true);
  const changed = new Promise((r) => c.on("notifications/tools/list_changed", r));
  await c.callTool("add_tool");
  await changed;
  assert.ok((await c.listAllTools()).some((t) => t.name === "added_later"));
  await c.close();
});

test("logging notifications reach on() listeners", async () => {
  const c = newClient();
  await c.connect();
  await c.setLoggingLevel("debug");
  const logs = [];
  c.on("notifications/message", (p) => logs.push(p.data));
  await c.callTool("log");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(logs, ["hello from the server"]);
  await c.close();
});

test("expired session (404) triggers a transparent re-initialize", async () => {
  const c = newClient();
  await c.connect();
  const first = c.sessionId;
  srv.expireSessions();
  const r = await c.callTool("echo", { text: "again" });
  assert.equal(r.structuredContent.echoed, "again");
  assert.notEqual(c.sessionId, first);
  await c.close();
});

test("close() sends DELETE for the session", async () => {
  const c = newClient();
  await c.connect();
  const sid = c.sessionId;
  await c.close();
  assert.ok(srv.state.deleted.includes(sid));
  assert.equal(c.sessionId, null);
});

test("MCP Apps metadata: ui resource uri, visibility and the ui:// resource", async () => {
  const c = newClient();
  await c.connect();
  const tools = await c.listAllTools();
  const counter = tools.find((t) => t.name === "counter");
  const inc = tools.find((t) => t.name === "counter_increment");
  assert.equal(getUiResourceUri(counter), "ui://counter/app.html");
  assert.equal(isModelVisible(counter), true);
  assert.equal(isModelVisible(inc), false);
  const res = await c.readResource("ui://counter/app.html");
  assert.equal(res.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(res.contents[0].text, /ui\/initialize/);
  await c.close();
});
