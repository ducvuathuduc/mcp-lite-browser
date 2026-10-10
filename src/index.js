// mcp-lite: a zero-dependency MCP client for the browser (Streamable HTTP)
// plus a minimal MCP Apps host bridge. MIT License.
//
//   const client = new McpHttpClient("/mcp", { protocolVersion: "2025-11-25" });
//   await client.connect();
//   const { tools } = await client.listTools();
//   const result = await client.callTool("start_drill", { learner_id: "lan" });

export class McpError extends Error {
  constructor(error) {
    super(error?.message || "MCP error");
    this.code = error?.code;
    this.data = error?.data;
  }
}

/** Parse a text/event-stream body and return the JSON-RPC messages it carries. */
export function parseSse(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch { /* ignore keep-alives */ }
  }
  return messages;
}

export class McpHttpClient {
  constructor(url, { protocolVersion = "2025-11-25", clientInfo, fetchImpl, onTraffic } = {}) {
    this.url = url;
    this.protocolVersion = protocolVersion;
    this.clientInfo = clientInfo || { name: "mcp-lite-browser", version: "1.0.0" };
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.onTraffic = onTraffic || (() => {});
    this.sessionId = null;
    this.serverInfo = null;
    this.serverCapabilities = null;
    this.negotiatedVersion = null;
    this._id = 0;
  }

  _headers() {
    const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (this.negotiatedVersion) h["mcp-protocol-version"] = this.negotiatedVersion;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }

  async _post(message) {
    this.onTraffic("out", message);
    const res = await this.fetch(this.url, { method: "POST", headers: this._headers(), body: JSON.stringify(message) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) return null;
    if (!res.ok) throw new McpError({ code: res.status, message: `HTTP ${res.status}: ${await res.text()}` });
    const type = res.headers.get("content-type") || "";
    const body = await res.text();
    const messages = type.includes("text/event-stream") ? parseSse(body) : body ? [JSON.parse(body)] : [];
    messages.forEach((m) => this.onTraffic("in", m));
    if (message.id === undefined) return null;
    const reply = messages.find((m) => m.id === message.id);
    if (!reply) throw new McpError({ message: `No response for request ${message.id}` });
    if (reply.error) throw new McpError(reply.error);
    return reply.result;
  }

  request(method, params = {}) {
    return this._post({ jsonrpc: "2.0", id: ++this._id, method, params });
  }

  notify(method, params = {}) {
    return this._post({ jsonrpc: "2.0", method, params });
  }

  async connect() {
    const result = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
      clientInfo: this.clientInfo,
    });
    this.negotiatedVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo;
    this.serverCapabilities = result.capabilities;
    this.instructions = result.instructions;
    await this.notify("notifications/initialized");
    return result;
  }

  listTools() { return this.request("tools/list"); }
  callTool(name, args = {}) { return this.request("tools/call", { name, arguments: args }); }
  listResources() { return this.request("resources/list"); }
  readResource(uri) { return this.request("resources/read", { uri }); }
  listPrompts() { return this.request("prompts/list"); }
  getPrompt(name, args = {}) { return this.request("prompts/get", { name, arguments: args }); }

  async close() {
    if (!this.sessionId) return;
    try { await this.fetch(this.url, { method: "DELETE", headers: this._headers() }); } catch { /* ignore */ }
    this.sessionId = null;
  }
}

/**
 * Minimal MCP Apps host bridge (SEP-1865, spec 2026-01-26).
 * Renders a ui:// resource in a sandboxed iframe, answers ui/initialize, pushes
 * tool input/result notifications, and proxies tools/call from the view to the server.
 */
export class AppBridge {
  constructor(iframe, { client, hostInfo, onSize, onToolResult, allowTool } = {}) {
    this.iframe = iframe;
    this.client = client;
    this.hostInfo = hostInfo || { name: "mcp-lite-host", version: "1.0.0" };
    this.onSize = onSize || (() => {});
    this.onToolResult = onToolResult || (() => {});
    this.allowTool = allowTool || (() => true);
    this.ready = false;
    this.queue = [];
    this._listener = (ev) => this._onMessage(ev);
    window.addEventListener("message", this._listener);
  }

  load(html) {
    this.ready = false;
    this.queue = [];
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.srcdoc = html;
  }

  _post(msg) { this.iframe.contentWindow?.postMessage(msg, "*"); }

  _send(method, params) {
    const msg = { jsonrpc: "2.0", method, params };
    if (this.ready) this._post(msg); else this.queue.push(msg);
  }

  sendToolInput(args) { this._send("ui/notifications/tool-input", { arguments: args || {} }); }
  sendToolResult(result) { this._send("ui/notifications/tool-result", result); }

  async _onMessage(ev) {
    if (ev.source !== this.iframe.contentWindow) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    const reply = (result, error) => this._post({ jsonrpc: "2.0", id: m.id, ...(error ? { error } : { result }) });
    switch (m.method) {
      case "ui/initialize":
        reply({
          protocolVersion: "2026-01-26",
          hostInfo: this.hostInfo,
          hostCapabilities: { serverTools: {}, serverResources: {}, openLinks: {} },
          hostContext: { theme: "dark", displayMode: "inline", availableDisplayModes: ["inline"] },
        });
        break;
      case "ui/notifications/initialized":
        this.ready = true;
        this.queue.splice(0).forEach((q) => this._post(q));
        break;
      case "ui/notifications/size-changed":
        this.onSize(m.params?.height);
        break;
      case "tools/call":
        if (!this.allowTool(m.params?.name)) { reply(null, { code: -32601, message: "Tool not allowed" }); break; }
        try {
          const result = await this.client.callTool(m.params.name, m.params.arguments || {});
          this.onToolResult(m.params.name, m.params.arguments || {}, result);
          reply(result);
        } catch (e) { reply(null, { code: e.code || -32000, message: e.message }); }
        break;
      case "ui/open-link": {
        const url = new URL(m.params?.url || "", window.location.href);
        if (!/^https?:$/.test(url.protocol)) { reply(null, { code: -32602, message: "Only http(s) links" }); break; }
        window.open(url.href, "_blank", "noopener");
        reply({});
        break;
      }
      case "resources/read":
        try { reply(await this.client.readResource(m.params.uri)); }
        catch (e) { reply(null, { code: e.code || -32000, message: e.message }); }
        break;
      default:
        if (m.id !== undefined) reply(null, { code: -32601, message: `Unsupported: ${m.method}` });
    }
  }

  destroy() { window.removeEventListener("message", this._listener); }
}
