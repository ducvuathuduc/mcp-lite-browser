import { type McpClient } from "./client.js";
import type { CallToolResult, DisplayMode, HostContext, Implementation, ResourceContents, Tool, UiCsp, UiResourceMeta } from "./types.js";
export declare const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";
export declare const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";
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
    onMessage?: (params: {
        role: string;
        content: unknown;
    }) => void | Promise<void>;
    /** `ui/update-model-context`. Throw to deny. */
    onUpdateModelContext?: (params: {
        content?: unknown[];
        structuredContent?: Record<string, unknown>;
    }) => void | Promise<void>;
    /** `ui/request-display-mode`: return the mode actually applied. Default: grant any available mode. */
    onRequestDisplayMode?: (mode: DisplayMode) => DisplayMode | Promise<DisplayMode>;
    /** `ui/open-link`: return false to deny. Default: open http(s) URLs in a new tab. */
    onOpenLink?: (url: string) => boolean | Promise<boolean>;
    /** `notifications/message` log lines from the view. */
    onLog?: (params: {
        level?: string;
        data?: unknown;
        logger?: string;
    }) => void;
}
/** Build the Content-Security-Policy the MCP Apps spec prescribes for a resource's declared domains. */
export declare function buildCsp(csp?: UiCsp): string;
/** Insert a CSP `<meta>` as the first element of `<head>` so it applies before any script runs. */
export declare function injectCsp(html: string, policy: string): string;
/** Decode a `resources/read` content entry for a UI resource into HTML plus its `_meta.ui`. */
export declare function decodeUiResource(c: ResourceContents): {
    html: string;
    meta: UiResourceMeta;
};
export declare class AppBridge {
    iframe: HTMLIFrameElement;
    ready: boolean;
    hostContext: HostContext;
    /** Display modes the view declared in `ui/initialize`. */
    appDisplayModes?: DisplayMode[];
    private o;
    private queue;
    private meta;
    private _seq;
    private _waiting;
    private _listener;
    constructor(iframe: HTMLIFrameElement, options?: AppBridgeOptions);
    /**
     * Render a tool's MCP App in `iframe` and feed it the call: reads the `ui://` resource, calls the tool,
     * then delivers `tool-input` and `tool-result`. Returns the bridge and the tool result.
     */
    static open(iframe: HTMLIFrameElement, client: McpClient, toolName: string, args?: Record<string, unknown>, options?: AppBridgeOptions): Promise<{
        bridge: AppBridge;
        result: CallToolResult;
    }>;
    /** Render a UI resource entry from `resources/read` (text or base64 blob), honouring its `_meta.ui`. */
    loadResource(contents: ResourceContents): void;
    /** Render raw view HTML with the CSP and permissions from `meta` (restrictive defaults when omitted). */
    load(html: string, meta?: UiResourceMeta): void;
    sendToolInput(args?: Record<string, unknown>): void;
    sendToolInputPartial(args?: Record<string, unknown>): void;
    sendToolResult(result: CallToolResult): void;
    sendToolCancelled(reason?: string): void;
    /** Merge into the host context and notify the view (`ui/notifications/host-context-changed`). */
    setHostContext(partial: Partial<HostContext>): void;
    /** Ask the view to save state (`ui/resource-teardown`), wait up to `timeout` ms, then unload it. */
    teardown(reason?: string, timeout?: number): Promise<void>;
    destroy(): void;
    private _post;
    private _send;
    private _onMessage;
}
export {};
