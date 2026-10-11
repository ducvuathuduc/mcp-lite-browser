export type RequestId = string | number;
export interface JsonRpcRequest {
    jsonrpc: "2.0";
    id: RequestId;
    method: string;
    params?: Record<string, any>;
}
export interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: Record<string, any>;
}
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: RequestId;
    result?: any;
    error?: JsonRpcError;
}
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
export interface Implementation {
    name: string;
    version: string;
    title?: string;
    [k: string]: unknown;
}
export interface ClientCapabilities {
    roots?: {
        listChanged?: boolean;
    };
    sampling?: {
        context?: object;
        tools?: object;
    };
    elicitation?: {
        form?: object;
        url?: object;
    };
    extensions?: Record<string, unknown>;
    experimental?: Record<string, unknown>;
    [k: string]: unknown;
}
export interface ServerCapabilities {
    tools?: {
        listChanged?: boolean;
    };
    resources?: {
        subscribe?: boolean;
        listChanged?: boolean;
    };
    prompts?: {
        listChanged?: boolean;
    };
    logging?: object;
    completions?: object;
    extensions?: Record<string, unknown>;
    [k: string]: unknown;
}
export interface InitializeResult {
    protocolVersion: string;
    capabilities: ServerCapabilities;
    serverInfo: Implementation;
    instructions?: string;
    [k: string]: unknown;
}
export interface McpUiToolMeta {
    resourceUri?: string;
    visibility?: Array<"model" | "app">;
}
export interface Tool {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, any>;
    outputSchema?: Record<string, any>;
    annotations?: Record<string, unknown>;
    _meta?: {
        ui?: McpUiToolMeta;
        "ui/resourceUri"?: string;
        [k: string]: unknown;
    };
    [k: string]: unknown;
}
export interface ContentBlock {
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [k: string]: unknown;
}
export interface CallToolResult {
    content: ContentBlock[];
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    _meta?: Record<string, unknown>;
    [k: string]: unknown;
}
export interface Resource {
    uri: string;
    name: string;
    title?: string;
    mimeType?: string;
    description?: string;
    [k: string]: unknown;
}
export interface ResourceTemplate {
    uriTemplate: string;
    name: string;
    mimeType?: string;
    [k: string]: unknown;
}
export interface ResourceContents {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    _meta?: Record<string, any>;
    [k: string]: unknown;
}
export interface Prompt {
    name: string;
    title?: string;
    description?: string;
    arguments?: Array<{
        name: string;
        description?: string;
        required?: boolean;
    }>;
    [k: string]: unknown;
}
export interface Root {
    uri: string;
    name?: string;
}
export interface Progress {
    progress: number;
    total?: number;
    message?: string;
}
/** Options accepted by every request helper. */
export interface RequestOptions {
    /** Abort the request; the client sends `notifications/cancelled` to the server. */
    signal?: AbortSignal;
    /** Milliseconds before the request is cancelled with a timeout error. Default: the client's `timeout`. */
    timeout?: number;
    /** Receive `notifications/progress` for this request (sets `_meta.progressToken`). */
    onProgress?: (progress: Progress) => void;
    /** Restart the timeout each time progress arrives. Default false. */
    resetTimeoutOnProgress?: boolean;
}
export interface ElicitRequestParams {
    mode?: "form" | "url";
    message: string;
    requestedSchema?: Record<string, any>;
    url?: string;
    elicitationId?: string;
    [k: string]: unknown;
}
export interface ElicitResult {
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
}
export interface CreateMessageParams {
    messages: Array<{
        role: "user" | "assistant";
        content: ContentBlock | ContentBlock[];
    }>;
    systemPrompt?: string;
    maxTokens: number;
    [k: string]: unknown;
}
export interface CreateMessageResult {
    role: "assistant";
    content: ContentBlock | ContentBlock[];
    model: string;
    stopReason?: string;
    [k: string]: unknown;
}
export type DisplayMode = "inline" | "fullscreen" | "pip";
export interface UiCsp {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
}
export interface UiPermissions {
    camera?: object;
    microphone?: object;
    geolocation?: object;
    clipboardWrite?: object;
}
export interface UiResourceMeta {
    csp?: UiCsp;
    permissions?: UiPermissions;
    domain?: string;
    prefersBorder?: boolean;
}
export interface HostContext {
    toolInfo?: {
        id?: RequestId;
        tool: Tool;
    };
    theme?: "light" | "dark";
    styles?: {
        variables?: Record<string, string | undefined>;
        css?: {
            fonts?: string;
        };
    };
    displayMode?: DisplayMode;
    availableDisplayModes?: DisplayMode[];
    containerDimensions?: {
        width?: number;
        maxWidth?: number;
        height?: number;
        maxHeight?: number;
    };
    locale?: string;
    timeZone?: string;
    userAgent?: string;
    platform?: "web" | "desktop" | "mobile";
    deviceCapabilities?: {
        touch?: boolean;
        hover?: boolean;
    };
    safeAreaInsets?: {
        top: number;
        right: number;
        bottom: number;
        left: number;
    };
    [k: string]: unknown;
}
