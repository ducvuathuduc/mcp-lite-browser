import { test } from "node:test";
import assert from "node:assert/strict";

// Minimal browser globals: a window that dispatches "message" events, and a fake iframe.
const listeners = [];
globalThis.window = {
  location: { href: "http://localhost/" },
  opened: [],
  addEventListener: (type, fn) => type === "message" && listeners.push(fn),
  removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
  open(url) { this.opened.push(url); },
};
const { AppBridge } = await import("../src/index.js");

function fakeIframe() {
  const posted = [];
  const contentWindow = { postMessage: (msg) => posted.push(msg) };
  return { posted, contentWindow, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, srcdoc: "" };
}
const fromView = async (iframe, data, source = iframe.contentWindow) => {
  for (const fn of [...listeners]) await fn({ source, data });
};

test("load() sandboxes the view and queues notifications until the view is initialized", async () => {
  const iframe = fakeIframe();
  const bridge = new AppBridge(iframe, { client: {} });
  bridge.load("<p>hi</p>");
  assert.equal(iframe.attrs.sandbox, "allow-scripts");
  assert.equal(iframe.srcdoc, "<p>hi</p>");
  bridge.sendToolInput({ learner_id: "lan" });
  bridge.sendToolResult({ structuredContent: { kind: "drill" } });
  assert.equal(iframe.posted.length, 0);

  await fromView(iframe, { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
  assert.equal(iframe.posted[0].id, 1);
  assert.equal(iframe.posted[0].result.protocolVersion, "2026-01-26");
  await fromView(iframe, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  assert.deepEqual(iframe.posted.slice(1).map((m) => m.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  bridge.destroy();
});

test("tools/call from the view is proxied to the MCP client, honours allowTool, ignores other windows", async () => {
  const iframe = fakeIframe();
  const calls = [];
  const seen = [];
  const client = { callTool: async (name, args) => { calls.push([name, args]); return { structuredContent: { ok: true } }; } };
  const bridge = new AppBridge(iframe, { client, allowTool: (n) => n !== "delete_everything", onToolResult: (...a) => seen.push(a) });

  await fromView(iframe, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "start_drill", arguments: { learner_id: "lan" } } });
  assert.deepEqual(calls, [["start_drill", { learner_id: "lan" }]]);
  assert.deepEqual(iframe.posted.at(-1), { jsonrpc: "2.0", id: 7, result: { structuredContent: { ok: true } } });
  assert.equal(seen.length, 1);

  await fromView(iframe, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "delete_everything" } });
  assert.equal(iframe.posted.at(-1).error.code, -32601);
  assert.equal(calls.length, 1);

  const before = iframe.posted.length;
  await fromView(iframe, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "start_drill" } }, { other: true });
  assert.equal(iframe.posted.length, before, "messages from other windows are ignored");
  bridge.destroy();
});

test("ui/open-link only opens http(s) URLs; unknown requests get -32601", async () => {
  const iframe = fakeIframe();
  const bridge = new AppBridge(iframe, { client: {} });
  await fromView(iframe, { jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
  assert.equal(iframe.posted.at(-1).error.code, -32602);
  await fromView(iframe, { jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "https://example.com/x" } });
  assert.deepEqual(window.opened, ["https://example.com/x"]);
  await fromView(iframe, { jsonrpc: "2.0", id: 3, method: "ui/whatever" });
  assert.equal(iframe.posted.at(-1).error.code, -32601);
  bridge.destroy();
});
