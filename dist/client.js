// McpClient: a zero-dependency MCP client over Streamable HTTP (spec 2025-11-25) for browsers, Node >= 18,
// Deno, Bun, Workers and anything else with `fetch`.
import { SseParser } from "./sse.js";
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const VERSION = "0.2.0";
/** Error carrying a JSON-RPC error code (or an HTTP status for transport failures). */
export class McpError extends Error {
    constructor(error) {
        super(error?.message || "MCP error");
        this.name = "McpError";
        this.code = error?.code;
        this.data = error?.data;
    }
}
const sleep = (ms, signal) => new Promise((res) => {
    if (signal?.aborted)
        return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});
export class McpClient {
    constructor(url, options = {}) {
        this.sessionId = null;
        this.negotiatedVersion = null;
        this.serverInfo = null;
        this.serverCapabilities = null;
        this.connected = false;
        this._id = 0;
        this._pending = new Map();
        this._handlers = new Map();
        this._listeners = new Map();
        this._listen = null;
        this.url = url;
        this.opts = options;
        this.protocolVersion = options.protocolVersion || LATEST_PROTOCOL_VERSION;
        this.clientInfo = options.clientInfo || { name: "mcp-lite-browser", version: VERSION };
        const f = options.fetch || options.fetchImpl;
        this.fetch = f ? f : (...a) => globalThis.fetch(...a);
        this._roots = options.roots;
        this.setRequestHandler("ping", () => ({}));
        if (options.roots)
            this.setRequestHandler("roots/list", () => ({ roots: this._roots || [] }));
        if (options.onElicit)
            this.setRequestHandler("elicitation/create", options.onElicit);
        if (options.onSampling)
            this.setRequestHandler("sampling/createMessage", options.onSampling);
    }
    // ---------------------------------------------------------------- events & handlers
    /** Subscribe to a server notification (e.g. `"notifications/tools/list_changed"`, or `"*"` for all). */
    on(method, fn) {
        let set = this._listeners.get(method);
        if (!set)
            this._listeners.set(method, (set = new Set()));
        set.add(fn);
        return () => set.delete(fn);
    }
    /** Answer a server-to-client request method (`ping`, `roots/list`, `sampling/createMessage`, …). */
    setRequestHandler(method, handler) { this._handlers.set(method, handler); }
    // ---------------------------------------------------------------- lifecycle
    async connect() {
        this.sessionId = null;
        this.negotiatedVersion = null;
        const o = this.opts;
        const capabilities = {
            ...(o.roots ? { roots: { listChanged: true } } : {}),
            ...(o.onSampling ? { sampling: {} } : {}),
            ...(o.onElicit ? { elicitation: { form: {}, url: {} } } : {}),
            ...(o.apps !== false ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {}),
            ...o.capabilities,
        };
        const result = await this.request("initialize", {
            protocolVersion: this.protocolVersion, capabilities, clientInfo: this.clientInfo,
        });
        if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
            await this.close();
            throw new McpError({ code: -32602, message: `Unsupported protocol version from server: ${result.protocolVersion}` });
        }
        this.negotiatedVersion = result.protocolVersion;
        this.serverInfo = result.serverInfo;
        this.serverCapabilities = result.capabilities;
        this.instructions = result.instructions;
        await this.notify("notifications/initialized");
        this.connected = true;
        if (o.listen)
            this.listen().catch(() => { });
        return result;
    }
    /** Stop listening, reject pending requests and DELETE the session (if the server issued one). */
    async close() {
        this._listen?.abort();
        this._listen = null;
        for (const p of [...this._pending.values()])
            p.reject(new McpError({ code: -32000, message: "Client closed" }));
        if (this.sessionId) {
            try {
                await this._http("DELETE");
            }
            catch { /* best effort */ }
        }
        this.sessionId = null;
        this.connected = false;
    }
    /**
     * Open the standalone GET SSE stream so the server can push notifications and requests at any time.
     * Resolves `true` once the stream is open, `false` if the server does not offer one (HTTP 405).
     * Reconnects with `Last-Event-ID` and honours the server's `retry:` field.
     */
    listen() {
        if (this._listen)
            return Promise.resolve(true);
        const ac = (this._listen = new AbortController());
        return new Promise((resolveOpen) => {
            let opened = false;
            const open = (v) => { if (!opened) {
                opened = true;
                resolveOpen(v);
            } };
            (async () => {
                let lastId, retry = this.opts.reconnectDelay ?? 1000, attempts = 0;
                while (!ac.signal.aborted) {
                    try {
                        const res = await this._http("GET", undefined, ac.signal, lastId ? { "last-event-id": lastId } : {});
                        if (res.status === 405) {
                            this._listen = null;
                            return open(false);
                        }
                        if (res.ok && (res.headers.get("content-type") || "").includes("text/event-stream")) {
                            open(true);
                            attempts = 0;
                            await this._read(res, "get-sse", ac.signal, (e) => {
                                if (e.id)
                                    lastId = e.id;
                                if (e.retry !== undefined)
                                    retry = e.retry;
                            });
                        }
                    }
                    catch { /* network error: fall through to retry */ }
                    if (ac.signal.aborted || ++attempts > (this.opts.maxRetries ?? 5))
                        break;
                    await sleep(Math.min(retry * 2 ** (attempts - 1), 30000), ac.signal);
                }
                if (this._listen === ac)
                    this._listen = null;
                open(false);
            })();
        });
    }
    // ---------------------------------------------------------------- JSON-RPC
    /** Send any JSON-RPC request. Supports cancellation (`signal`), timeouts and progress. */
    request(method, params = {}, options = {}) {
        const id = ++this._id;
        const p = { ...params };
        if (options.onProgress)
            p._meta = { ...p._meta, progressToken: id };
        const message = { jsonrpc: "2.0", id, method, params: p };
        const timeout = options.timeout ?? this.opts.timeout ?? 60000;
        const { signal } = options;
        return new Promise((resolve, reject) => {
            if (signal?.aborted)
                return reject(signal.reason ?? new McpError({ code: -32800, message: "Request cancelled" }));
            const ac = new AbortController();
            let timer;
            const done = () => { clearTimeout(timer); this._pending.delete(id); signal?.removeEventListener("abort", onAbort); };
            const cancel = (reason, err) => {
                if (!this._pending.has(id))
                    return;
                done();
                reject(err);
                ac.abort();
                // The spec forbids cancelling `initialize`.
                if (method !== "initialize")
                    this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => { });
            };
            const arm = () => {
                clearTimeout(timer);
                if (timeout > 0)
                    timer = setTimeout(() => cancel("timeout", new McpError({ code: -32001, message: `Request timed out after ${timeout} ms` })), timeout);
            };
            const onAbort = () => {
                const r = signal.reason;
                cancel(r instanceof Error ? r.message : String(r ?? "aborted"), r instanceof Error ? r : new McpError({ code: -32800, message: "Request cancelled" }));
            };
            this._pending.set(id, {
                resolve: (v) => { done(); resolve(v); },
                reject: (e) => { done(); ac.abort(); reject(e); },
                onProgress: (pr) => { options.onProgress?.(pr); if (options.resetTimeoutOnProgress)
                    arm(); },
            });
            signal?.addEventListener("abort", onAbort, { once: true });
            arm();
            this._post(message, ac.signal).catch((e) => {
                if (!ac.signal.aborted)
                    this._pending.get(id)?.reject(e);
            });
        });
    }
    /** Send a JSON-RPC notification. */
    async notify(method, params = {}) {
        await this._post({ jsonrpc: "2.0", method, params });
    }
    // ---------------------------------------------------------------- helpers
    ping(options) { return this.request("ping", {}, options); }
    listTools(params = {}, options) {
        return this.request("tools/list", params, options);
    }
    /** Every tool, following `nextCursor` pagination. */
    listAllTools(options) { return this._all("tools/list", "tools", options); }
    callTool(name, args = {}, options) {
        return this.request("tools/call", { name, arguments: args }, options);
    }
    listResources(params = {}, options) {
        return this.request("resources/list", params, options);
    }
    listAllResources(options) { return this._all("resources/list", "resources", options); }
    listResourceTemplates(params = {}, options) {
        return this.request("resources/templates/list", params, options);
    }
    readResource(uri, options) {
        return this.request("resources/read", { uri }, options);
    }
    subscribeResource(uri, options) { return this.request("resources/subscribe", { uri }, options); }
    unsubscribeResource(uri, options) { return this.request("resources/unsubscribe", { uri }, options); }
    listPrompts(params = {}, options) {
        return this.request("prompts/list", params, options);
    }
    listAllPrompts(options) { return this._all("prompts/list", "prompts", options); }
    getPrompt(name, args = {}, options) {
        return this.request("prompts/get", { name, arguments: args }, options);
    }
    complete(ref, argument, context, options) {
        return this.request("completion/complete", { ref, argument, ...(context ? { context } : {}) }, options);
    }
    setLoggingLevel(level, options) {
        return this.request("logging/setLevel", { level }, options);
    }
    /** Replace the roots and tell the server (`notifications/roots/list_changed`). */
    async setRoots(roots) {
        this._roots = roots;
        if (!this._handlers.has("roots/list"))
            this.setRequestHandler("roots/list", () => ({ roots: this._roots || [] }));
        if (this.connected)
            await this.notify("notifications/roots/list_changed");
    }
    // ---------------------------------------------------------------- transport internals
    async _all(method, key, options) {
        const out = [];
        let cursor;
        do {
            const page = await this.request(method, cursor ? { cursor } : {}, options);
            out.push(...(page[key] || []));
            cursor = page.nextCursor;
        } while (cursor);
        return out;
    }
    async _http(method, body, signal, extra = {}, retried = false) {
        const o = this.opts;
        const headers = {
            accept: method === "GET" ? "text/event-stream" : "application/json, text/event-stream",
            ...(body ? { "content-type": "application/json" } : {}),
            ...(this.negotiatedVersion ? { "mcp-protocol-version": this.negotiatedVersion } : {}),
            ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
            ...(typeof o.headers === "function" ? await o.headers() : o.headers),
            ...(o.auth ? await o.auth.headers() : {}),
            ...extra,
        };
        const res = await this.fetch(this.url, { method, headers, body, signal });
        const sid = res.headers.get("mcp-session-id");
        if (sid)
            this.sessionId = sid;
        const www = res.headers.get("www-authenticate");
        if (!retried && o.auth?.onUnauthorized && (res.status === 401 || (res.status === 403 && /insufficient_scope/.test(www || "")))) {
            if (await o.auth.onUnauthorized({ status: res.status, wwwAuthenticate: www, url: this.url })) {
                return this._http(method, body, signal, extra, true);
            }
        }
        return res;
    }
    async _post(message, signal, retried = false) {
        const isRequest = "method" in message && "id" in message;
        this._traffic("out", message, "post");
        const res = await this._http("POST", JSON.stringify(message), signal);
        const m = message;
        if (res.status === 404 && this.sessionId && !retried && m.method !== "initialize") {
            // Session expired: the spec requires a fresh initialize without the old session id.
            this.sessionId = null;
            this.connected = false;
            if (this.opts.reconnectOnSessionExpired !== false && m.method !== "notifications/initialized") {
                await this.connect();
                return this._post(message, signal, true);
            }
            throw new McpError({ code: 404, message: "Session expired" });
        }
        if (res.status === 202 || res.status === 204)
            return;
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            let data;
            try {
                data = JSON.parse(text);
            }
            catch { /* not JSON */ }
            throw new McpError({ code: res.status, message: data?.error?.message ? `HTTP ${res.status}: ${data.error.message}` : `HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}`, data });
        }
        const type = res.headers.get("content-type") || "";
        if (type.includes("text/event-stream"))
            return this._consume(res, isRequest ? m.id : undefined, signal);
        const text = await res.text();
        if (text) {
            const parsed = JSON.parse(text);
            for (const msg of Array.isArray(parsed) ? parsed : [parsed])
                this._dispatch(msg, "json");
        }
        if (isRequest && this._pending.has(m.id))
            throw new McpError({ code: -32603, message: `No response for request ${m.id}` });
    }
    /** Read a POST-initiated SSE stream; resume it with GET + Last-Event-ID if it drops before the response. */
    async _consume(res, id, signal) {
        let lastId, retry = this.opts.reconnectDelay ?? 1000, attempts = 0;
        for (let via = "post-sse";; via = "resume") {
            await this._read(res, via, signal, (e) => {
                if (e.id)
                    lastId = e.id;
                if (e.retry !== undefined)
                    retry = e.retry;
            });
            if (id === undefined || !this._pending.has(id) || signal?.aborted)
                return;
            if (!lastId || attempts >= (this.opts.maxRetries ?? 5)) {
                throw new McpError({ code: -32603, message: `SSE stream closed before the response to request ${id}` });
            }
            attempts++;
            await sleep(retry, signal);
            if (signal?.aborted)
                return;
            res = await this._http("GET", undefined, signal, { "last-event-id": lastId });
            if (!res.ok)
                throw new McpError({ code: res.status, message: `Could not resume SSE stream: HTTP ${res.status}` });
        }
    }
    async _read(res, via, signal, onEvent) {
        const parser = new SseParser((e) => {
            onEvent(e);
            if (!e.data)
                return; // priming event or keep-alive
            let msg;
            try {
                msg = JSON.parse(e.data);
            }
            catch {
                return;
            }
            this._dispatch(msg, via);
        });
        try {
            if (!res.body?.getReader) {
                parser.push(await res.text());
                parser.end();
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                if (signal?.aborted) {
                    reader.cancel().catch(() => { });
                    return;
                }
                const { value, done } = await reader.read();
                if (done)
                    break;
                parser.push(decoder.decode(value, { stream: true }));
            }
            parser.push(decoder.decode());
            parser.end();
        }
        catch {
            /* dropped connection or abort: the caller decides whether to resume */
        }
    }
    _traffic(direction, message, via) {
        try {
            this.opts.onTraffic?.(direction, message, { time: Date.now(), via });
        }
        catch { /* never let a logger break the client */ }
    }
    _dispatch(msg, via) {
        if (!msg || msg.jsonrpc !== "2.0")
            return;
        this._traffic("in", msg, via);
        if (typeof msg.method === "string") {
            if (msg.id !== undefined) {
                this._serve(msg);
                return;
            }
            if (msg.method === "notifications/progress") {
                this._pending.get(msg.params?.progressToken)?.onProgress?.(msg.params);
            }
            for (const key of [msg.method, "*"])
                this._listeners.get(key)?.forEach((fn) => { try {
                    fn(msg.params, msg);
                }
                catch { /* listener error */ } });
            return;
        }
        const p = this._pending.get(msg.id);
        if (!p)
            return;
        if (msg.error)
            p.reject(new McpError(msg.error));
        else
            p.resolve(msg.result);
    }
    async _serve(req) {
        let reply;
        try {
            const h = this._handlers.get(req.method);
            if (!h)
                throw new McpError({ code: -32601, message: `Method not found: ${req.method}` });
            reply = { jsonrpc: "2.0", id: req.id, result: (await h(req.params || {}, req)) ?? {} };
        }
        catch (e) {
            reply = { jsonrpc: "2.0", id: req.id, error: { code: typeof e?.code === "number" ? e.code : -32603, message: e?.message || String(e) } };
        }
        await this._post(reply).catch(() => { });
    }
}
/** Backwards-compatible name from v0.1. */
export { McpClient as McpHttpClient };
/** The `ui://` resource a tool renders into, if any (supports the deprecated flat `_meta["ui/resourceUri"]`). */
export function getUiResourceUri(tool) {
    return tool?._meta?.ui?.resourceUri || tool?._meta?.["ui/resourceUri"];
}
/** Tools the model may see (MCP Apps `visibility` includes `"model"`, the default). */
export function isModelVisible(tool) {
    const v = tool._meta?.ui?.visibility;
    return !v || v.includes("model");
}
/** A static bearer-token AuthProvider. */
export function bearer(token) {
    return { headers: async () => ({ authorization: `Bearer ${typeof token === "function" ? await token() : token}` }) };
}
