// AppBridge: a small MCP Apps host (SEP-1865, stable 2026-01-26). Renders a `ui://` view in a sandboxed iframe,
// enforces the resource's declared CSP and permissions, and speaks the view's JSON-RPC-over-postMessage dialect.
import { getUiResourceUri, type McpClient } from "./client.js";
import type { CallToolResult, DisplayMode, HostContext, Implementation, ResourceContents, Tool, UiCsp, UiPermissions, UiResourceMeta } from "./types.js";

export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

type ClientLike = Pick<McpClient, "callTool" | "readResource">;

export interface AppBridgeOptions {
  /** Client used to proxy the view's `tools/call` and `resources/read` to the server. */
  client?: ClientLike;
  hostInfo?: Implementation;
  /** Sent in the `ui/initialize` result. Update it later with `setHostContext`. */
  hostContext?: HostContext;
  /** The server's tool list, used to enforce `_meta.ui.visibility` (app-only / model-only tools). */
  tools?: Tool[];
  /** Extra allow-list for tool calls coming from the view. */
  allowTool?: (name: string) => boolean;
  /** iframe `sandbox` attribute. Default `"allow-scripts"` (opaque origin, no access to the host page). */
  sandbox?: string;
  onToolResult?: (name: string, args: Record<string, unknown>, result: CallToolResult) => void;
  /** `ui/notifications/size-changed`. */
  onSize?: (height: number | undefined, width: number | undefined) => void;
  /** `ui/message`: the view wants to add a message to the conversation. Throw to deny. */
  onMessage?: (params: { role: string; content: unknown }) => void | Promise<void>;
  /** `ui/update-model-context`. Throw to deny. */
  onUpdateModelContext?: (params: { content?: unknown[]; structuredContent?: Record<string, unknown> }) => void | Promise<void>;
  /** `ui/request-display-mode`: return the mode actually applied. Default: grant any available mode. */
  onRequestDisplayMode?: (mode: DisplayMode) => DisplayMode | Promise<DisplayMode>;
  /** `ui/open-link`: return false to deny. Default: open http(s) URLs in a new tab. */
  onOpenLink?: (url: string) => boolean | Promise<boolean>;
  /** `notifications/message` log lines from the view. */
  onLog?: (params: { level?: string; data?: unknown; logger?: string }) => void;
}

const PERMISSION_FEATURES: Record<keyof UiPermissions, string> = {
  camera: "camera", microphone: "microphone", geolocation: "geolocation", clipboardWrite: "clipboard-write",
};

/** Build the Content-Security-Policy the MCP Apps spec prescribes for a resource's declared domains. */
export function buildCsp(csp: UiCsp = {}): string {
  const res = (csp.resourceDomains || []).join(" ");
  const join = (...parts: string[]) => parts.filter(Boolean).join(" ");
  return [
    "default-src 'none'",
    `script-src ${join("'self' 'unsafe-inline'", res)}`,
    `style-src ${join("'self' 'unsafe-inline'", res)}`,
    `connect-src ${join("'self'", (csp.connectDomains || []).join(" "))}`,
    `img-src ${join("'self' data:", res)}`,
    `font-src ${join("'self'", res)}`,
    `media-src ${join("'self' data:", res)}`,
    `frame-src ${(csp.frameDomains || []).join(" ") || "'none'"}`,
    "object-src 'none'",
    `base-uri ${(csp.baseUriDomains || []).join(" ") || "'self'"}`,
  ].join("; ");
}

/** Insert a CSP `<meta>` as the first element of `<head>` so it applies before any script runs. */
export function injectCsp(html: string, policy: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + "<head>" + meta + "</head>" + html.slice(doctype[0].length);
  return "<head>" + meta + "</head>" + html;
}

/** Decode a `resources/read` content entry for a UI resource into HTML plus its `_meta.ui`. */
export function decodeUiResource(c: ResourceContents): { html: string; meta: UiResourceMeta } {
  let html = c.text ?? "";
  if (!c.text && c.blob) {
    const bin = atob(c.blob);
    html = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  }
  return { html, meta: c._meta?.ui || {} };
}

export class AppBridge {
  iframe: HTMLIFrameElement;
  ready = false;
  hostContext: HostContext;
  /** Display modes the view declared in `ui/initialize`. */
  appDisplayModes?: DisplayMode[];
  private o: AppBridgeOptions;
  private queue: object[] = [];
  private meta: UiResourceMeta = {};
  private _seq = 0;
  private _waiting = new Map<string, (m: any) => void>();
  private _listener: (ev: MessageEvent) => void;

  constructor(iframe: HTMLIFrameElement, options: AppBridgeOptions = {}) {
    this.iframe = iframe;
    this.o = options;
    this.hostContext = { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"], platform: "web", ...options.hostContext };
    this._listener = (ev) => { this._onMessage(ev); };
    window.addEventListener("message", this._listener);
  }

  /**
   * Render a tool's MCP App in `iframe` and feed it the call: reads the `ui://` resource, calls the tool,
   * then delivers `tool-input` and `tool-result`. Returns the bridge and the tool result.
   */
  static async open(iframe: HTMLIFrameElement, client: McpClient, toolName: string, args: Record<string, unknown> = {}, options: AppBridgeOptions = {}) {
    const tools = options.tools || (await client.listAllTools());
    const tool = tools.find((t) => t.name === toolName);
    const uri = getUiResourceUri(tool);
    if (!uri) throw new Error(`Tool "${toolName}" has no MCP App (_meta.ui.resourceUri)`);
    const read = await client.readResource(uri);
    const bridge = new AppBridge(iframe, { client, tools, ...options, hostContext: { toolInfo: { tool: tool! }, ...options.hostContext } });
    bridge.loadResource(read.contents[0]);
    bridge.sendToolInput(args);
    try {
      const result = await client.callTool(toolName, args);
      bridge.sendToolResult(result);
      return { bridge, result };
    } catch (e: any) {
      bridge.sendToolCancelled(e?.message || "Tool call failed");
      throw e;
    }
  }

  /** Render a UI resource entry from `resources/read` (text or base64 blob), honouring its `_meta.ui`. */
  loadResource(contents: ResourceContents): void {
    const { html, meta } = decodeUiResource(contents);
    this.load(html, meta);
  }

  /** Render raw view HTML with the CSP and permissions from `meta` (restrictive defaults when omitted). */
  load(html: string, meta: UiResourceMeta = {}): void {
    this.ready = false;
    this.queue = [];
    this.meta = meta;
    const allow = Object.entries(meta.permissions || {})
      .filter(([k, v]) => v && k in PERMISSION_FEATURES)
      .map(([k]) => `${PERMISSION_FEATURES[k as keyof UiPermissions]} *`);
    if (allow.length) this.iframe.setAttribute("allow", allow.join("; "));
    else this.iframe.removeAttribute?.("allow");
    this.iframe.setAttribute("sandbox", this.o.sandbox || "allow-scripts");
    this.iframe.srcdoc = injectCsp(html, buildCsp(meta.csp));
  }

  sendToolInput(args: Record<string, unknown> = {}): void { this._send("ui/notifications/tool-input", { arguments: args }); }
  sendToolInputPartial(args: Record<string, unknown> = {}): void { this._send("ui/notifications/tool-input-partial", { arguments: args }); }
  sendToolResult(result: CallToolResult): void { this._send("ui/notifications/tool-result", result); }
  sendToolCancelled(reason = "cancelled"): void { this._send("ui/notifications/tool-cancelled", { reason }); }

  /** Merge into the host context and notify the view (`ui/notifications/host-context-changed`). */
  setHostContext(partial: Partial<HostContext>): void {
    this.hostContext = { ...this.hostContext, ...partial };
    this._send("ui/notifications/host-context-changed", partial);
  }

  /** Ask the view to save state (`ui/resource-teardown`), wait up to `timeout` ms, then unload it. */
  async teardown(reason = "host closed the view", timeout = 2000): Promise<void> {
    if (this.ready) {
      const id = `host-${++this._seq}`;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { this._waiting.delete(id); resolve(); }, timeout);
        this._waiting.set(id, () => { clearTimeout(t); resolve(); });
        this._post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: { reason } });
      });
    }
    this.destroy();
    this.iframe.srcdoc = "";
  }

  destroy(): void { window.removeEventListener("message", this._listener); this.ready = false; }

  private _post(msg: object): void { this.iframe.contentWindow?.postMessage(msg, "*"); }

  private _send(method: string, params: object): void {
    const msg = { jsonrpc: "2.0", method, params };
    // The spec forbids host → view traffic before the view's `initialized` notification.
    if (this.ready) this._post(msg); else this.queue.push(msg);
  }

  private async _onMessage(ev: MessageEvent): Promise<void> {
    if (ev.source !== this.iframe.contentWindow) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.method === undefined) { this._waiting.get(m.id)?.(m); this._waiting.delete(m.id); return; }
    const reply = (result: unknown, error?: { code: number; message: string }) => {
      if (m.id !== undefined) this._post({ jsonrpc: "2.0", id: m.id, ...(error ? { error } : { result }) });
    };
    const fail = (e: any, code = -32000) => reply(null, { code: typeof e?.code === "number" ? e.code : code, message: e?.message || String(e) });
    const o = this.o;
    const p = m.params || {};
    try {
      switch (m.method) {
        case "ui/initialize":
          this.appDisplayModes = p.appCapabilities?.availableDisplayModes;
          return reply({
            protocolVersion: MCP_APPS_PROTOCOL_VERSION,
            hostInfo: o.hostInfo || { name: "mcp-lite-browser", version: "0.2.0" },
            hostCapabilities: {
              openLinks: {}, logging: {},
              ...(o.client ? { serverTools: {}, serverResources: {} } : {}),
              sandbox: { permissions: this.meta.permissions || {}, csp: this.meta.csp || {} },
            },
            hostContext: this.hostContext,
          });
        case "ui/notifications/initialized":
          this.ready = true;
          this.queue.splice(0).forEach((q) => this._post(q));
          return;
        case "ui/notifications/size-changed":
          return o.onSize?.(p.height, p.width);
        case "notifications/message":
          return o.onLog?.(p);
        case "ping":
          return reply({});
        case "tools/call": {
          const name = p.name;
          const tool = o.tools?.find((t) => t.name === name);
          const vis = tool?._meta?.ui?.visibility;
          if ((vis && !vis.includes("app")) || (o.allowTool && !o.allowTool(name))) return fail({ code: -32601, message: `Tool not allowed from the view: ${name}` });
          if (!o.client) return fail({ code: -32601, message: "Host has no MCP client" });
          const result = await o.client.callTool(name, p.arguments || {});
          o.onToolResult?.(name, p.arguments || {}, result);
          return reply(result);
        }
        case "resources/read":
          if (!o.client) return fail({ code: -32601, message: "Host has no MCP client" });
          return reply(await o.client.readResource(p.uri));
        case "ui/open-link": {
          const url = new URL(p.url || "", window.location.href);
          if (!/^https?:$/.test(url.protocol)) return fail({ code: -32602, message: "Only http(s) links can be opened" });
          if (o.onOpenLink) { if (!(await o.onOpenLink(url.href))) return fail({ message: "Link opening denied" }); }
          else window.open(url.href, "_blank", "noopener,noreferrer");
          return reply({});
        }
        case "ui/message":
          if (!o.onMessage) return fail({ message: "Host does not accept messages" });
          await o.onMessage(p);
          return reply({});
        case "ui/update-model-context":
          if (!o.onUpdateModelContext) return fail({ message: "Host does not accept model context" });
          await o.onUpdateModelContext(p);
          return reply({});
        case "ui/request-display-mode": {
          const current = this.hostContext.displayMode || "inline";
          const available = this.hostContext.availableDisplayModes || ["inline"];
          let mode: DisplayMode = available.includes(p.mode) && (!this.appDisplayModes || this.appDisplayModes.includes(p.mode)) ? p.mode : current;
          if (o.onRequestDisplayMode && mode !== current) mode = await o.onRequestDisplayMode(mode);
          if (mode !== current) this.setHostContext({ displayMode: mode });
          return reply({ mode });
        }
        default:
          if (m.id !== undefined) fail({ code: -32601, message: `Unsupported: ${m.method}` });
      }
    } catch (e) {
      fail(e);
    }
  }
}
