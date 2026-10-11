// AppBridge: a small MCP Apps host (SEP-1865, stable 2026-01-26). Renders a `ui://` view in a sandboxed iframe,
// enforces the resource's declared CSP and permissions, and speaks the view's JSON-RPC-over-postMessage dialect.
import { getUiResourceUri } from "./client.js";
export const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
const PERMISSION_FEATURES = {
    camera: "camera", microphone: "microphone", geolocation: "geolocation", clipboardWrite: "clipboard-write",
};
/** Build the Content-Security-Policy the MCP Apps spec prescribes for a resource's declared domains. */
export function buildCsp(csp = {}) {
    const res = (csp.resourceDomains || []).join(" ");
    const join = (...parts) => parts.filter(Boolean).join(" ");
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
export function injectCsp(html, policy) {
    const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replace(/"/g, "&quot;")}">`;
    const head = /<head(\s[^>]*)?>/i.exec(html);
    if (head)
        return html.slice(0, head.index + head[0].length) + meta + html.slice(head.index + head[0].length);
    const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
    if (doctype)
        return doctype[0] + "<head>" + meta + "</head>" + html.slice(doctype[0].length);
    return "<head>" + meta + "</head>" + html;
}
/** Decode a `resources/read` content entry for a UI resource into HTML plus its `_meta.ui`. */
export function decodeUiResource(c) {
    let html = c.text ?? "";
    if (!c.text && c.blob) {
        const bin = atob(c.blob);
        html = new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    }
    return { html, meta: c._meta?.ui || {} };
}
export class AppBridge {
    constructor(iframe, options = {}) {
        this.ready = false;
        this.queue = [];
        this.meta = {};
        this._seq = 0;
        this._waiting = new Map();
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
    static async open(iframe, client, toolName, args = {}, options = {}) {
        const tools = options.tools || (await client.listAllTools());
        const tool = tools.find((t) => t.name === toolName);
        const uri = getUiResourceUri(tool);
        if (!uri)
            throw new Error(`Tool "${toolName}" has no MCP App (_meta.ui.resourceUri)`);
        const read = await client.readResource(uri);
        const bridge = new AppBridge(iframe, { client, tools, ...options, hostContext: { toolInfo: { tool: tool }, ...options.hostContext } });
        bridge.loadResource(read.contents[0]);
        bridge.sendToolInput(args);
        try {
            const result = await client.callTool(toolName, args);
            bridge.sendToolResult(result);
            return { bridge, result };
        }
        catch (e) {
            bridge.sendToolCancelled(e?.message || "Tool call failed");
            throw e;
        }
    }
    /** Render a UI resource entry from `resources/read` (text or base64 blob), honouring its `_meta.ui`. */
    loadResource(contents) {
        const { html, meta } = decodeUiResource(contents);
        this.load(html, meta);
    }
    /** Render raw view HTML with the CSP and permissions from `meta` (restrictive defaults when omitted). */
    load(html, meta = {}) {
        this.ready = false;
        this.queue = [];
        this.meta = meta;
        const allow = Object.entries(meta.permissions || {})
            .filter(([k, v]) => v && k in PERMISSION_FEATURES)
            .map(([k]) => `${PERMISSION_FEATURES[k]} *`);
        if (allow.length)
            this.iframe.setAttribute("allow", allow.join("; "));
        else
            this.iframe.removeAttribute?.("allow");
        this.iframe.setAttribute("sandbox", this.o.sandbox || "allow-scripts");
        this.iframe.srcdoc = injectCsp(html, buildCsp(meta.csp));
    }
    sendToolInput(args = {}) { this._send("ui/notifications/tool-input", { arguments: args }); }
    sendToolInputPartial(args = {}) { this._send("ui/notifications/tool-input-partial", { arguments: args }); }
    sendToolResult(result) { this._send("ui/notifications/tool-result", result); }
    sendToolCancelled(reason = "cancelled") { this._send("ui/notifications/tool-cancelled", { reason }); }
    /** Merge into the host context and notify the view (`ui/notifications/host-context-changed`). */
    setHostContext(partial) {
        this.hostContext = { ...this.hostContext, ...partial };
        this._send("ui/notifications/host-context-changed", partial);
    }
    /** Ask the view to save state (`ui/resource-teardown`), wait up to `timeout` ms, then unload it. */
    async teardown(reason = "host closed the view", timeout = 2000) {
        if (this.ready) {
            const id = `host-${++this._seq}`;
            await new Promise((resolve) => {
                const t = setTimeout(() => { this._waiting.delete(id); resolve(); }, timeout);
                this._waiting.set(id, () => { clearTimeout(t); resolve(); });
                this._post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: { reason } });
            });
        }
        this.destroy();
        this.iframe.srcdoc = "";
    }
    destroy() { window.removeEventListener("message", this._listener); this.ready = false; }
    _post(msg) { this.iframe.contentWindow?.postMessage(msg, "*"); }
    _send(method, params) {
        const msg = { jsonrpc: "2.0", method, params };
        // The spec forbids host → view traffic before the view's `initialized` notification.
        if (this.ready)
            this._post(msg);
        else
            this.queue.push(msg);
    }
    async _onMessage(ev) {
        if (ev.source !== this.iframe.contentWindow)
            return;
        const m = ev.data;
        if (!m || m.jsonrpc !== "2.0")
            return;
        if (m.method === undefined) {
            this._waiting.get(m.id)?.(m);
            this._waiting.delete(m.id);
            return;
        }
        const reply = (result, error) => {
            if (m.id !== undefined)
                this._post({ jsonrpc: "2.0", id: m.id, ...(error ? { error } : { result }) });
        };
        const fail = (e, code = -32000) => reply(null, { code: typeof e?.code === "number" ? e.code : code, message: e?.message || String(e) });
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
                    if ((vis && !vis.includes("app")) || (o.allowTool && !o.allowTool(name)))
                        return fail({ code: -32601, message: `Tool not allowed from the view: ${name}` });
                    if (!o.client)
                        return fail({ code: -32601, message: "Host has no MCP client" });
                    const result = await o.client.callTool(name, p.arguments || {});
                    o.onToolResult?.(name, p.arguments || {}, result);
                    return reply(result);
                }
                case "resources/read":
                    if (!o.client)
                        return fail({ code: -32601, message: "Host has no MCP client" });
                    return reply(await o.client.readResource(p.uri));
                case "ui/open-link": {
                    const url = new URL(p.url || "", window.location.href);
                    if (!/^https?:$/.test(url.protocol))
                        return fail({ code: -32602, message: "Only http(s) links can be opened" });
                    if (o.onOpenLink) {
                        if (!(await o.onOpenLink(url.href)))
                            return fail({ message: "Link opening denied" });
                    }
                    else
                        window.open(url.href, "_blank", "noopener,noreferrer");
                    return reply({});
                }
                case "ui/message":
                    if (!o.onMessage)
                        return fail({ message: "Host does not accept messages" });
                    await o.onMessage(p);
                    return reply({});
                case "ui/update-model-context":
                    if (!o.onUpdateModelContext)
                        return fail({ message: "Host does not accept model context" });
                    await o.onUpdateModelContext(p);
                    return reply({});
                case "ui/request-display-mode": {
                    const current = this.hostContext.displayMode || "inline";
                    const available = this.hostContext.availableDisplayModes || ["inline"];
                    let mode = available.includes(p.mode) && (!this.appDisplayModes || this.appDisplayModes.includes(p.mode)) ? p.mode : current;
                    if (o.onRequestDisplayMode && mode !== current)
                        mode = await o.onRequestDisplayMode(mode);
                    if (mode !== current)
                        this.setHostContext({ displayMode: mode });
                    return reply({ mode });
                }
                default:
                    if (m.id !== undefined)
                        fail({ code: -32601, message: `Unsupported: ${m.method}` });
            }
        }
        catch (e) {
            fail(e);
        }
    }
}
