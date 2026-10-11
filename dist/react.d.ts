import { createMcpStore, type McpState, type McpStore } from "./store.js";
import type { ClientOptions } from "./client.js";
export interface UseMcpResult extends McpState {
    client: McpStore["client"];
    connect: McpStore["connect"];
    disconnect: McpStore["disconnect"];
    refresh: McpStore["refresh"];
    callTool: McpStore["client"]["callTool"];
}
/**
 * Connect to an MCP server and keep its tools, resources and prompts in React state.
 *
 *   const { status, tools, callTool } = useMcp("https://example.com/mcp");
 */
export declare function useMcp(url: string, options?: ClientOptions & {
    autoConnect?: boolean;
}): UseMcpResult;
export { createMcpStore };
export type { McpState, McpStore };
