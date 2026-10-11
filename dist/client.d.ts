import type { CallToolResult, ClientCapabilities, CreateMessageParams, CreateMessageResult, ElicitRequestParams, ElicitResult, Implementation, InitializeResult, JsonRpcError, JsonRpcMessage, JsonRpcRequest, Prompt, RequestOptions, Resource, ResourceContents, ResourceTemplate, Root, ServerCapabilities, Tool } from "./types.js";
export declare const LATEST_PROTOCOL_VERSION = "2025-11-25";
export declare const SUPPORTED_PROTOCOL_VERSIONS: string[];
export declare const VERSION = "0.2.0";
/** Error carrying a JSON-RPC error code (or an HTTP status for transport failures). */
export declare class McpError extends Error {
    code?: number;
    data?: unknown;
    constructor(error?: Partial<JsonRpcError>);
}
/** Pluggable authorization: static bearer tokens, the bundled OAuth 2.1 flow, or your own. */
export interface AuthProvider {
    /** Headers to add to every HTTP request, e.g. `{ authorization: "Bearer …" }`. */
    headers(): Record<string, string> | Promise<Record<string, string>>;
    /** Called on HTTP 401, or 403 `insufficient_scope`. Resolve `true` to retry the request once. */
    onUnauthorized?(info: {
        status: number;
        wwwAuthenticate: string | null;
        url: string;
    }): Promise<boolean>;
}
export type TrafficDirection = "out" | "in";
export interface TrafficMeta {
    time: number;
    via: "post" | "post-sse" | "get-sse" | "json" | "resume";
}
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
export declare class McpClient {
    readonly url: string;
    protocolVersion: string;
    clientInfo: Implementation;
    sessionId: string | null;
    negotiatedVersion: string | null;
    serverInfo: Implementation | null;
    serverCapabilities: ServerCapabilities | null;
    instructions?: string;
    connected: boolean;
    private opts;
    private fetch;
    private _id;
    private _pending;
    private _handlers;
    private _listeners;
    private _listen;
    private _roots?;
    constructor(url: string, options?: ClientOptions);
    /** Subscribe to a server notification (e.g. `"notifications/tools/list_changed"`, or `"*"` for all). */
    on(method: string, fn: (params: any, message: JsonRpcMessage) => void): () => void;
    /** Answer a server-to-client request method (`ping`, `roots/list`, `sampling/createMessage`, …). */
    setRequestHandler(method: string, handler: Handler): void;
    connect(): Promise<InitializeResult>;
    /** Stop listening, reject pending requests and DELETE the session (if the server issued one). */
    close(): Promise<void>;
    /**
     * Open the standalone GET SSE stream so the server can push notifications and requests at any time.
     * Resolves `true` once the stream is open, `false` if the server does not offer one (HTTP 405).
     * Reconnects with `Last-Event-ID` and honours the server's `retry:` field.
     */
    listen(): Promise<boolean>;
    /** Send any JSON-RPC request. Supports cancellation (`signal`), timeouts and progress. */
    request<T = any>(method: string, params?: Record<string, any>, options?: RequestOptions): Promise<T>;
    /** Send a JSON-RPC notification. */
    notify(method: string, params?: Record<string, any>): Promise<void>;
    ping(options?: RequestOptions): Promise<{}>;
    listTools(params?: {
        cursor?: string;
    }, options?: RequestOptions): Promise<{
        tools: Tool[];
        nextCursor?: string;
    }>;
    /** Every tool, following `nextCursor` pagination. */
    listAllTools(options?: RequestOptions): Promise<Tool[]>;
    callTool(name: string, args?: Record<string, unknown>, options?: RequestOptions): Promise<CallToolResult>;
    listResources(params?: {
        cursor?: string;
    }, options?: RequestOptions): Promise<{
        resources: Resource[];
        nextCursor?: string;
    }>;
    listAllResources(options?: RequestOptions): Promise<Resource[]>;
    listResourceTemplates(params?: {
        cursor?: string;
    }, options?: RequestOptions): Promise<{
        resourceTemplates: ResourceTemplate[];
        nextCursor?: string;
    }>;
    readResource(uri: string, options?: RequestOptions): Promise<{
        contents: ResourceContents[];
    }>;
    subscribeResource(uri: string, options?: RequestOptions): Promise<{}>;
    unsubscribeResource(uri: string, options?: RequestOptions): Promise<{}>;
    listPrompts(params?: {
        cursor?: string;
    }, options?: RequestOptions): Promise<{
        prompts: Prompt[];
        nextCursor?: string;
    }>;
    listAllPrompts(options?: RequestOptions): Promise<Prompt[]>;
    getPrompt(name: string, args?: Record<string, string>, options?: RequestOptions): Promise<{
        description?: string;
        messages: any[];
    }>;
    complete(ref: {
        type: "ref/prompt";
        name: string;
    } | {
        type: "ref/resource";
        uri: string;
    }, argument: {
        name: string;
        value: string;
    }, context?: {
        arguments?: Record<string, string>;
    }, options?: RequestOptions): Promise<{
        completion: {
            values: string[];
            total?: number;
            hasMore?: boolean;
        };
    }>;
    setLoggingLevel(level: "debug" | "info" | "notice" | "warning" | "error" | "critical" | "alert" | "emergency", options?: RequestOptions): Promise<{}>;
    /** Replace the roots and tell the server (`notifications/roots/list_changed`). */
    setRoots(roots: Root[]): Promise<void>;
    private _all;
    private _http;
    private _post;
    /** Read a POST-initiated SSE stream; resume it with GET + Last-Event-ID if it drops before the response. */
    private _consume;
    private _read;
    private _traffic;
    private _dispatch;
    private _serve;
}
/** Backwards-compatible name from v0.1. */
export { McpClient as McpHttpClient };
/** The `ui://` resource a tool renders into, if any (supports the deprecated flat `_meta["ui/resourceUri"]`). */
export declare function getUiResourceUri(tool: Tool | undefined): string | undefined;
/** Tools the model may see (MCP Apps `visibility` includes `"model"`, the default). */
export declare function isModelVisible(tool: Tool): boolean;
/** A static bearer-token AuthProvider. */
export declare function bearer(token: string | (() => string | Promise<string>)): AuthProvider;
