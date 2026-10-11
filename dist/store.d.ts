import { McpClient, type ClientOptions } from "./client.js";
import type { Implementation, Prompt, Resource, Tool } from "./types.js";
export type McpStatus = "idle" | "connecting" | "ready" | "failed" | "closed";
export interface McpState {
    status: McpStatus;
    tools: Tool[];
    resources: Resource[];
    prompts: Prompt[];
    serverInfo: Implementation | null;
    error: Error | null;
}
export interface McpStore {
    client: McpClient;
    subscribe(fn: (state: McpState) => void): () => void;
    getSnapshot(): McpState;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    /** Re-fetch tools, resources and prompts (also done automatically on `list_changed`). */
    refresh(): Promise<void>;
}
export declare function createMcpStore(url: string, options?: ClientOptions): McpStore;
