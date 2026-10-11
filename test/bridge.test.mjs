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
const { AppBridge, buildCsp, injectCsp, decodeUiResource } = await import("../dist/index.js");

function fakeIframe() {
  const posted = [];
  const contentWindow = { postMessage: (msg) => posted.push(msg) };
  return { posted, contentWindow, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, srcdoc: "" };
}
const fromView = async (iframe, data, source = iframe.contentWindow) => {
  for (const fn of [...listeners]) await fn({ source, data });
  await new Promise((r) => setTimeout(r, 0));
};
const init = async (iframe, params = {}) => {
  await fromView(iframe, { jsonrpc: "2.0", id: "i", method: "ui/initialize", params });
  await fromView(iframe, { jsonrpc: "2.0", method: "ui/notifications/initialized" });
  return iframe.posted.find((m) => m.id === "i").result;
};

test("buildCsp follows the spec: restrictive default, declared domains only", () => {
  const def = buildCsp();
  assert.match(def, /default-src 'none'/);
  assert.match(def, /connect-src 'self'(;|$)/);
  assert.match(def, /frame-src 'none'/);
  assert.match(def, /object-src 'none'/);
  const csp = buildCsp({ connectDomains: ["https://api.x.com"], resourceDomains: ["https://cdn.x.com"], frameDomains: ["https://youtube.com"] });
  assert.match(csp, /connect-src 'self' https:\/\/api\.x\.com/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/cdn\.x\.com/);
  assert.match(csp, /frame-src https:\/\/youtube\.com/);
});

test("injectCsp puts the meta tag first in <head>, or creates a head", () => {
  assert.match(injectCsp("<!doctype html><html><head><title>t</title></head></html>", "x"), /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="x"><title>/);
  assert.match(injectCsp("<!DOCTYPE html><p>hi</p>", "x"), /^<!DOCTYPE html><head><meta http-equiv/);
  assert.match(injectCsp("<p>hi</p>", "x"), /^<head><meta/);
});

test("decodeUiResource decodes base64 blobs (UTF-8) and returns _meta.ui", () => {
  const blob = Buffer.from("<p>xin chào</p>").toString("base64");
  const r = decodeUiResource({ uri: "ui://a", blob, _meta: { ui: { prefersBorder: true } } });
  assert.equal(r.html, "<p>xin chào</p>");
  assert.deepEqual(r.meta, { prefersBorder: true });
});

test("load() sandboxes the view, enforces CSP, maps permissions, queues notifications until initialized", async () => {
  const iframe = fakeIframe();
  const bridge = new AppBridge(iframe, { client: {}, hostContext: { theme: "dark" } });
  bridge.load("<html><head></head><p>hi</p></html>", { permissions: { microphone: {}, clipboardWrite: {} }, csp: { connectDomains: ["https://api.x.com"] } });
  assert.equal(iframe.attrs.sandbox, "allow-scripts");
  assert.equal(iframe.attrs.allow, "microphone *; clipboard-write *");
  assert.match(iframe.srcdoc, /Content-Security-Policy" content="default-src 'none'.*connect-src 'self' https:\/\/api\.x\.com/);
  bridge.sendToolInput({ city: "Hue" });
  bridge.sendToolResult({ content: [], structuredContent: { t: 31 } });
  assert.equal(iframe.posted.length, 0);
  const result = await init(iframe, { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } });
  assert.equal(result.protocolVersion, "2026-01-26");
  assert.equal(result.hostContext.theme, "dark");
  assert.deepEqual(result.hostCapabilities.sandbox.permissions, { microphone: {}, clipboardWrite: {} });
  assert.deepEqual(iframe.posted.slice(1).map((m) => m.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  bridge.destroy();
});

test("tools/call from the view is proxied; visibility and allowTool are enforced; other windows ignored", async () => {
  const iframe = fakeIframe();
  const calls = [], results = [];
  const client = { callTool: async (name, args) => { calls.push(name); return { content: [], structuredContent: { ok: name, args } }; } };
  const tools = [
    { name: "refresh", inputSchema: {}, _meta: { ui: { visibility: ["app"] } } },
    { name: "model_only", inputSchema: {}, _meta: { ui: { visibility: ["model"] } } },
    { name: "secret", inputSchema: {} },
  ];
  const bridge = new AppBridge(iframe, { client, tools, allowTool: (n) => n !== "secret", onToolResult: (n) => results.push(n) });
  bridge.load("<p></p>");
  await init(iframe);
  await fromView(iframe, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "refresh", arguments: { a: 1 } } });
  await fromView(iframe, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "model_only" } });
  await fromView(iframe, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "secret" } });
  await fromView(iframe, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "refresh" } }, { postMessage() {} });
  const byId = (id) => iframe.posted.find((m) => m.id === id);
  assert.deepEqual(byId(1).result.structuredContent, { ok: "refresh", args: { a: 1 } });
  assert.equal(byId(2).error.code, -32601);
  assert.equal(byId(3).error.code, -32601);
  assert.equal(byId(4), undefined);
  assert.deepEqual(calls, ["refresh"]);
  assert.deepEqual(results, ["refresh"]);
  bridge.destroy();
});

test("ui/message, ui/update-model-context and notifications/message reach the host callbacks", async () => {
  const iframe = fakeIframe();
  const got = {};
  const bridge = new AppBridge(iframe, {
    onMessage: (p) => { got.message = p; },
    onUpdateModelContext: (p) => { got.ctx = p; },
    onLog: (p) => { got.log = p; },
  });
  bridge.load("<p></p>");
  await init(iframe);
  await fromView(iframe, { jsonrpc: "2.0", id: 1, method: "ui/message", params: { role: "user", content: { type: "text", text: "book it" } } });
  await fromView(iframe, { jsonrpc: "2.0", id: 2, method: "ui/update-model-context", params: { structuredContent: { selected: 3 } } });
  await fromView(iframe, { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "clicked" } });
  assert.equal(got.message.content.text, "book it");
  assert.deepEqual(got.ctx.structuredContent, { selected: 3 });
  assert.equal(got.log.data, "clicked");
  assert.deepEqual(iframe.posted.find((m) => m.id === 1).result, {});
  // Without handlers the host declines politely.
  const iframe2 = fakeIframe();
  const b2 = new AppBridge(iframe2, {});
  b2.load("<p></p>");
  await init(iframe2);
  await fromView(iframe2, { jsonrpc: "2.0", id: 9, method: "ui/message", params: {} });
  assert.equal(iframe2.posted.find((m) => m.id === 9).error.code, -32000);
  bridge.destroy(); b2.destroy();
});

test("ui/request-display-mode grants only modes both sides support and notifies the change", async () => {
  const iframe = fakeIframe();
  const bridge = new AppBridge(iframe, { hostContext: { availableDisplayModes: ["inline", "fullscreen"] } });
  bridge.load("<p></p>");
  await init(iframe, { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } });
  await fromView(iframe, { jsonrpc: "2.0", id: 1, method: "ui/request-display-mode", params: { mode: "pip" } });
  await fromView(iframe, { jsonrpc: "2.0", id: 2, method: "ui/request-display-mode", params: { mode: "fullscreen" } });
  assert.deepEqual(iframe.posted.find((m) => m.id === 1).result, { mode: "inline" });
  assert.deepEqual(iframe.posted.find((m) => m.id === 2).result, { mode: "fullscreen" });
  const changed = iframe.posted.find((m) => m.method === "ui/notifications/host-context-changed");
  assert.deepEqual(changed.params, { displayMode: "fullscreen" });
  assert.equal(bridge.hostContext.displayMode, "fullscreen");
  bridge.destroy();
});

test("ui/open-link only opens http(s) URLs; ping works; unknown requests get -32601", async () => {
  const iframe = fakeIframe();
  const bridge = new AppBridge(iframe, {});
  bridge.load("<p></p>");
  await init(iframe);
  await fromView(iframe, { jsonrpc: "2.0", id: 1, method: "ui/open-link", params: { url: "https://example.com/x" } });
  await fromView(iframe, { jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "javascript:alert(1)" } });
  await fromView(iframe, { jsonrpc: "2.0", id: 3, method: "ping" });
  await fromView(iframe, { jsonrpc: "2.0", id: 4, method: "ui/does-not-exist" });
  assert.deepEqual(window.opened, ["https://example.com/x"]);
  assert.equal(iframe.posted.find((m) => m.id === 2).error.code, -32602);
  assert.deepEqual(iframe.posted.find((m) => m.id === 3).result, {});
  assert.equal(iframe.posted.find((m) => m.id === 4).error.code, -32601);
  bridge.destroy();
});

test("teardown() sends ui/resource-teardown, waits for the view's answer, then unloads", async () => {
  const iframe = fakeIframe();
  const bridge = new AppBridge(iframe, {});
  bridge.load("<p></p>");
  await init(iframe);
  const done = bridge.teardown("user closed it", 1000);
  const req = iframe.posted.find((m) => m.method === "ui/resource-teardown");
  assert.equal(req.params.reason, "user closed it");
  await fromView(iframe, { jsonrpc: "2.0", id: req.id, result: {} });
  await done;
  assert.equal(iframe.srcdoc, "");
  assert.equal(listeners.length, 0);
});

test("AppBridge.open() reads the ui:// resource, calls the tool and delivers input + result", async () => {
  const iframe = fakeIframe();
  const client = {
    listAllTools: async () => [{ name: "weather", inputSchema: {}, _meta: { ui: { resourceUri: "ui://w/app.html" } } }],
    readResource: async (uri) => ({ contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: "<html><head></head></html>" }] }),
    callTool: async () => ({ content: [{ type: "text", text: "31°C" }], structuredContent: { t: 31 } }),
  };
  const { bridge, result } = await AppBridge.open(iframe, client, "weather", { city: "Hue" });
  assert.equal(result.structuredContent.t, 31);
  const r = await init(iframe);
  assert.equal(r.hostContext.toolInfo.tool.name, "weather");
  assert.deepEqual(iframe.posted.slice(1).map((m) => m.method), ["ui/notifications/tool-input", "ui/notifications/tool-result"]);
  await assert.rejects(() => AppBridge.open(fakeIframe(), { ...client, listAllTools: async () => [{ name: "plain", inputSchema: {} }] }, "plain"), /no MCP App/);
  bridge.destroy();
});
