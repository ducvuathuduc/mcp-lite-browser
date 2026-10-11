// McpClient: a zero-dependency MCP client over Streamable HTTP (spec 2025-11-25) for browsers, Node >= 18,
// Deno, Bun, Workers and anything else with `fetch`.
import { SseParser, type SseEvent } from "./sse.js";
import type {
  CallToolResult, ClientCapabilities, CreateMessageParams, CreateMessageResult, ElicitRequestParams, ElicitResult,
  Implementation, InitializeResult, JsonRpcError, JsonRpcMessage, JsonRpcRequest, Progress, Prompt, RequestOptions,
  Resource, ResourceContents, ResourceTemplate, Root, ServerCapabilities, Tool,
} from "./types.js";

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const VERSION = "0.2.0";

/** Error carrying a JSON-RPC error code (or an HTTP status for transport failures). */
export class McpError extends Error {
  code?: number;
  data?: unknown;
  constructor(error?: Partial<JsonRpcError>) {
    super(error?.message || "MCP error");
    this.name = "McpError";
    this.code = error?.code;
    this.data = error?.data;
  }
}

/** Pluggable authorization: static bearer tokens, the bundled OAuth 2.1 flow, or your own. */
export interface AuthProvider {
  /** Headers to add to every HTTP request, e.g. `{ authorization: "Bearer …" }`. */
  headers(): Record<string, string> | Promise<Record<string, string>>;
  /** Called on HTTP 401, or 403 `insufficient_scope`. Resolve `true` to retry the request once. */
  onUnauthorized?(info: { status: number; wwwAuthenticate: string | null; url: string }): Promise<boolean>;
}

export type TrafficDirection = "out" | "in";
export interface TrafficMeta { time: number; via: "post" | "post-sse" | "get-sse" | "json" | "resume" }

export interface ClientOptions {
  /** Version offered in `initialize`. Default `"2025-11-25"`. */
  protocolVersion?: string;
  clientInfo?: Implementation;
  /** Extra capabilities merged into what the client advertises. */
  capabilities?: ClientCapabilities;
  /** Custom fetch (proxies, tests, Node polyfills). `fetchImpl` is accepted as an alias. */
  fetch?: typeof fetch;
  fetchImpl?: typeof fetch;
  /** Extra HTTP headers for every request, or a function returning them. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  auth?: AuthProvider;
  /** Sees every JSON-RPC message in both directions: build an inspector in a few lines. */
  onTraffic?: (direction: TrafficDirection, message: JsonRpcMessage, meta: TrafficMeta) => void;
  /** Default request timeout in ms (0 disables). Default 60 000. */
  timeout?: number;
  /** SSE reconnection attempts before giving up. Default 5. */
  maxRetries?: number;
  /** First reconnection delay in ms when the server sends no `retry:` field. Default 1000. */
  reconnectDelay?: number;
  /** Re-initialize transparently when the server answers 404 for an expired session. Default true. */
  reconnectOnSessionExpired?: boolean;
  /** Advertise the MCP Apps extension (`io.modelcontextprotocol/ui`). Default true. */
  apps?: boolean;
  /** Open the standalone GET SSE stream after connecting, for server notifications/requests. Default false. */
  listen?: boolean;
  /** Answer `elicitation/create` (form and URL mode). Declares the `elicitation` capability. */
  onElicit?: (params: ElicitRequestParams) => ElicitResult | Promise<ElicitResult>;
  /** Answer `sampling/createMessage`. Declares the `sampling` capability. */
  onSampling?: (params: CreateMessageParams) => CreateMessageResult | Promise<CreateMessageResult>;
  /** Roots exposed through `roots/list`. Declares the `roots` capability. */
  roots?: Root[];
}

type Handler = (params: any, request: JsonRpcRequest) => unknown;
interface Pending { resolve(v: any): void; reject(e: unknown): void; onProgress?(p: Progress): void }

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    if (signal?.aborted) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
  });

export class McpClient {
  readonly url: string;
  protocolVersion: string;
  clientInfo: Implementation;
  sessionId: string | null = null;
  negotiatedVersion: string | null = null;
  serverInfo: Implementation | null = null;
  serverCapabilities: ServerCapabilities | null = null;
  instructions?: string;
  connected = false;

  private opts: ClientOptions;
  private fetch: typeof fetch;
  private _id = 0;
  private _pending = new Map<number | string, Pending>();
  private _handlers = new Map<string, Handler>();
  private _listeners = new Map<string, Set<(params: any, message: JsonRpcMessage) => void>>();
  private _listen: AbortController | null = null;
  private _roots?: Root[];

  constructor(url: string, options: ClientOptions = {}) {
    this.url = url;
    this.opts = options;
    this.protocolVersion = options.protocolVersion || LATEST_PROTOCOL_VERSION;
    this.clientInfo = options.clientInfo || { name: "mcp-lite-browser", version: VERSION };
    const f = options.fetch || options.fetchImpl;
    this.fetch = f ? f : (...a: Parameters<typeof fetch>) => globalThis.fetch(...a);
    this._roots = options.roots;
    this.setRequestHandler("ping", () => ({}));
    if (options.roots) this.setRequestHandler("roots/list", () => ({ roots: this._roots || [] }));
    if (options.onElicit) this.setRequestHandler("elicitation/create", options.onElicit);
    if (options.onSampling) this.setRequestHandler("sampling/createMessage", options.onSampling);
  }

  // ---------------------------------------------------------------- events & handlers

  /** Subscribe to a server notification (e.g. `"notifications/tools/list_changed"`, or `"*"` for all). */
  on(method: string, fn: (params: any, message: JsonRpcMessage) => void): () => void {
    let set = this._listeners.get(method);
    if (!set) this._listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Answer a server-to-client request method (`ping`, `roots/list`, `sampling/createMessage`, …). */
  setRequestHandler(method: string, handler: Handler): void { this._handlers.set(method, handler); }

  // ---------------------------------------------------------------- lifecycle

  async connect(): Promise<InitializeResult> {
    this.sessionId = null;
    this.negotiatedVersion = null;
    const o = this.opts;
    const capabilities: ClientCapabilities = {
      ...(o.roots ? { roots: { listChanged: true } } : {}),
      ...(o.onSampling ? { sampling: {} } : {}),
      ...(o.onElicit ? { elicitation: { form: {}, url: {} } } : {}),
      ...(o.apps !== false ? { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } } : {}),
      ...o.capabilities,
    };
    const result: InitializeResult = await this.request("initialize", {
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
    if (o.listen) this.listen().catch(() => {});
    return result;
  }

  /** Stop listening, reject pending requests and DELETE the session (if the server issued one). */
  async close(): Promise<void> {
    this._listen?.abort();
    this._listen = null;
    for (const p of [...this._pending.values()]) p.reject(new McpError({ code: -32000, message: "Client closed" }));
    if (this.sessionId) {
      try { await this._http("DELETE"); } catch { /* best effort */ }
    }
    this.sessionId = null;
    this.connected = false;
  }

  /**
   * Open the standalone GET SSE stream so the server can push notifications and requests at any time.
   * Resolves `true` once the stream is open, `false` if the server does not offer one (HTTP 405).
   * Reconnects with `Last-Event-ID` and honours the server's `retry:` field.
   */
  listen(): Promise<boolean> {
    if (this._listen) return Promise.resolve(true);
    const ac = (this._listen = new AbortController());
    return new Promise<boolean>((resolveOpen) => {
      let opened = false;
      const open = (v: boolean) => { if (!opened) { opened = true; resolveOpen(v); } };
      (async () => {
        let lastId: string | undefined, retry = this.opts.reconnectDelay ?? 1000, attempts = 0;
        while (!ac.signal.aborted) {
          try {
            const res = await this._http("GET", undefined, ac.signal, lastId ? { "last-event-id": lastId } : {});
            if (res.status === 405) { this._listen = null; return open(false); }
            if (res.ok && (res.headers.get("content-type") || "").includes("text/event-stream")) {
              open(true);
              attempts = 0;
              await this._read(res, "get-sse", ac.signal, (e) => {
                if (e.id) lastId = e.id;
                if (e.retry !== undefined) retry = e.retry;
              });
            }
          } catch { /* network error: fall through to retry */ }
          if (ac.signal.aborted || ++attempts > (this.opts.maxRetries ?? 5)) break;
          await sleep(Math.min(retry * 2 ** (attempts - 1), 30000), ac.signal);
        }
        if (this._listen === ac) this._listen = null;
        open(false);
      })();
    });
  }

  // ---------------------------------------------------------------- JSON-RPC

  /** Send any JSON-RPC request. Supports cancellation (`signal`), timeouts and progress. */
  request<T = any>(method: string, params: Record<string, any> = {}, options: RequestOptions = {}): Promise<T> {
    const id = ++this._id;
    const p: Record<string, any> = { ...params };
    if (options.onProgress) p._meta = { ...p._meta, progressToken: id };
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params: p };
    const timeout = options.timeout ?? this.opts.timeout ?? 60000;
    const { signal } = options;
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new McpError({ code: -32800, message: "Request cancelled" }));
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { clearTimeout(timer); this._pending.delete(id); signal?.removeEventListener("abort", onAbort); };
      const cancel = (reason: string, err: unknown) => {
        if (!this._pending.has(id)) return;
        done(); reject(err); ac.abort();
        // The spec forbids cancelling `initialize`.
        if (method !== "initialize") this.notify("notifications/cancelled", { requestId: id, reason }).catch(() => {});
      };
      const arm = () => {
        clearTimeout(timer);
        if (timeout > 0) timer = setTimeout(() => cancel("timeout", new McpError({ code: -32001, message: `Request timed out after ${timeout} ms` })), timeout);
      };
      const onAbort = () => {
        const r = signal!.reason;
        cancel(r instanceof Error ? r.message : String(r ?? "aborted"), r instanceof Error ? r : new McpError({ code: -32800, message: "Request cancelled" }));
      };
      this._pending.set(id, {
        resolve: (v) => { done(); resolve(v); },
        reject: (e) => { done(); ac.abort(); reject(e); },
        onProgress: (pr) => { options.onProgress?.(pr); if (options.resetTimeoutOnProgress) arm(); },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      arm();
      this._post(message, ac.signal).catch((e) => {
        if (!ac.signal.aborted) this._pending.get(id)?.reject(e);
      });
    });
  }

  /** Send a JSON-RPC notification. */
  async notify(method: string, params: Record<string, any> = {}): Promise<void> {
    await this._post({ jsonrpc: "2.0", method, params });
  }

  // ---------------------------------------------------------------- helpers

  ping(options?: RequestOptions) { return this.request<{}>("ping", {}, options); }

  listTools(params: { cursor?: string } = {}, options?: RequestOptions) {
    return this.request<{ tools: Tool[]; nextCursor?: string }>("tools/list", params, options);
  }
  /** Every tool, following `nextCursor` pagination. */
  listAllTools(options?: RequestOptions) { return this._all<Tool>("tools/list", "tools", options); }
  callTool(name: string, args: Record<string, unknown> = {}, options?: RequestOptions) {
    return this.request<CallToolResult>("tools/call", { name, arguments: args }, options);
  }

  listResources(params: { cursor?: string } = {}, options?: RequestOptions) {
    return this.request<{ resources: Resource[]; nextCursor?: string }>("resources/list", params, options);
  }
  listAllResources(options?: RequestOptions) { return this._all<Resource>("resources/list", "resources", options); }
  listResourceTemplates(params: { cursor?: string } = {}, options?: RequestOptions) {
    return this.request<{ resourceTemplates: ResourceTemplate[]; nextCursor?: string }>("resources/templates/list", params, options);
  }
  readResource(uri: string, options?: RequestOptions) {
    return this.request<{ contents: ResourceContents[] }>("resources/read", { uri }, options);
  }
  subscribeResource(uri: string, options?: RequestOptions) { return this.request<{}>("resources/subscribe", { uri }, options); }
  unsubscribeResource(uri: string, options?: RequestOptions) { return this.request<{}>("resources/unsubscribe", { uri }, options); }

  listPrompts(params: { cursor?: string } = {}, options?: RequestOptions) {
    return this.request<{ prompts: Prompt[]; nextCursor?: string }>("prompts/list", params, options);
  }
  listAllPrompts(options?: RequestOptions) { return this._all<Prompt>("prompts/list", "prompts", options); }
  getPrompt(name: string, args: Record<string, string> = {}, options?: RequestOptions) {
    return this.request<{ description?: string; messages: any[] }>("prompts/get", { name, arguments: args }, options);
  }

  complete(ref: { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string }, argument: { name: string; value: string }, context?: { arguments?: Record<string, string> }, options?: RequestOptions) {
    return this.request<{ completion: { values: string[]; total?: number; hasMore?: boolean } }>("completion/complete", { ref, argument, ...(context ? { context } : {}) }, options);
  }
  setLoggingLevel(level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency", options?: RequestOptions) {
    return this.request<{}>("logging/setLevel", { level }, options);
  }

  /** Replace the roots and tell the server (`notifications/roots/list_changed`). */
  async setRoots(roots: Root[]): Promise<void> {
    this._roots = roots;
    if (!this._handlers.has("roots/list")) this.setRequestHandler("roots/list", () => ({ roots: this._roots || [] }));
    if (this.connected) await this.notify("notifications/roots/list_changed");
  }

  // ---------------------------------------------------------------- transport internals

  private async _all<T>(method: string, key: string, options?: RequestOptions): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const page: any = await this.request(method, cursor ? { cursor } : {}, options);
      out.push(...(page[key] || []));
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  private async _http(method: string, body?: string, signal?: AbortSignal, extra: Record<string, string> = {}, retried = false): Promise<Response> {
    const o = this.opts;
    const headers: Record<string, string> = {
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
    if (sid) this.sessionId = sid;
    const www = res.headers.get("www-authenticate");
    if (!retried && o.auth?.onUnauthorized && (res.status === 401 || (res.status === 403 && /insufficient_scope/.test(www || "")))) {
      if (await o.auth.onUnauthorized({ status: res.status, wwwAuthenticate: www, url: this.url })) {
        return this._http(method, body, signal, extra, true);
      }
    }
    return res;
  }

  private async _post(message: JsonRpcMessage, signal?: AbortSignal, retried = false): Promise<void> {
    const isRequest = "method" in message && "id" in message;
    this._traffic("out", message, "post");
    const res = await this._http("POST", JSON.stringify(message), signal);
    const m = message as JsonRpcRequest;
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
    if (res.status === 202 || res.status === 204) return;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let data: any;
      try { data = JSON.parse(text); } catch { /* not JSON */ }
      throw new McpError({ code: res.status, message: data?.error?.message ? `HTTP ${res.status}: ${data.error.message}` : `HTTP ${res.status}${text ? ": " + text.slice(0, 200) : ""}`, data });
    }
    const type = res.headers.get("content-type") || "";
    if (type.includes("text/event-stream")) return this._consume(res, isRequest ? m.id : undefined, signal);
    const text = await res.text();
    if (text) {
      const parsed = JSON.parse(text);
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) this._dispatch(msg, "json");
    }
    if (isRequest && this._pending.has(m.id)) throw new McpError({ code: -32603, message: `No response for request ${m.id}` });
  }

  /** Read a POST-initiated SSE stream; resume it with GET + Last-Event-ID if it drops before the response. */
  private async _consume(res: Response, id: number | string | undefined, signal?: AbortSignal): Promise<void> {
    let lastId: string | undefined, retry = this.opts.reconnectDelay ?? 1000, attempts = 0;
    for (let via: TrafficMeta["via"] = "post-sse"; ; via = "resume") {
      await this._read(res, via, signal, (e) => {
        if (e.id) lastId = e.id;
        if (e.retry !== undefined) retry = e.retry;
      });
      if (id === undefined || !this._pending.has(id) || signal?.aborted) return;
      if (!lastId || attempts >= (this.opts.maxRetries ?? 5)) {
        throw new McpError({ code: -32603, message: `SSE stream closed before the response to request ${id}` });
      }
      attempts++;
      await sleep(retry, signal);
      if (signal?.aborted) return;
      res = await this._http("GET", undefined, signal, { "last-event-id": lastId });
      if (!res.ok) throw new McpError({ code: res.status, message: `Could not resume SSE stream: HTTP ${res.status}` });
    }
  }

  private async _read(res: Response, via: TrafficMeta["via"], signal: AbortSignal | undefined, onEvent: (e: SseEvent) => void): Promise<void> {
    const parser = new SseParser((e) => {
      onEvent(e);
      if (!e.data) return; // priming event or keep-alive
      let msg: any;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._dispatch(msg, via);
    });
    try {
      if (!res.body?.getReader) { parser.push(await res.text()); parser.end(); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        if (signal?.aborted) { reader.cancel().catch(() => {}); return; }
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
      }
      parser.push(decoder.decode());
      parser.end();
    } catch {
      /* dropped connection or abort: the caller decides whether to resume */
    }
  }

  private _traffic(direction: TrafficDirection, message: JsonRpcMessage, via: TrafficMeta["via"]): void {
    try { this.opts.onTraffic?.(direction, message, { time: Date.now(), via }); } catch { /* never let a logger break the client */ }
  }

  private _dispatch(msg: any, via: TrafficMeta["via"]): void {
    if (!msg || msg.jsonrpc !== "2.0") return;
    this._traffic("in", msg, via);
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) { this._serve(msg); return; }
      if (msg.method === "notifications/progress") {
        this._pending.get(msg.params?.progressToken)?.onProgress?.(msg.params);
      }
      for (const key of [msg.method, "*"]) this._listeners.get(key)?.forEach((fn) => { try { fn(msg.params, msg); } catch { /* listener error */ } });
      return;
    }
    const p = this._pending.get(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new McpError(msg.error));
    else p.resolve(msg.result);
  }

  private async _serve(req: JsonRpcRequest): Promise<void> {
    let reply: JsonRpcMessage;
    try {
      const h = this._handlers.get(req.method);
      if (!h) throw new McpError({ code: -32601, message: `Method not found: ${req.method}` });
      reply = { jsonrpc: "2.0", id: req.id, result: (await h(req.params || {}, req)) ?? {} };
    } catch (e: any) {
      reply = { jsonrpc: "2.0", id: req.id, error: { code: typeof e?.code === "number" ? e.code : -32603, message: e?.message || String(e) } };
    }
    await this._post(reply).catch(() => {});
  }
}

/** Backwards-compatible name from v0.1. */
export { McpClient as McpHttpClient };

/** The `ui://` resource a tool renders into, if any (supports the deprecated flat `_meta["ui/resourceUri"]`). */
export function getUiResourceUri(tool: Tool | undefined): string | undefined {
  return tool?._meta?.ui?.resourceUri || tool?._meta?.["ui/resourceUri"];
}

/** Tools the model may see (MCP Apps `visibility` includes `"model"`, the default). */
export function isModelVisible(tool: Tool): boolean {
  const v = tool._meta?.ui?.visibility;
  return !v || v.includes("model");
}

/** A static bearer-token AuthProvider. */
export function bearer(token: string | (() => string | Promise<string>)): AuthProvider {
  return { headers: async () => ({ authorization: `Bearer ${typeof token === "function" ? await token() : token}` }) };
}
