// React binding: `useMcp(url, options)`. React is a peer dependency; nothing else is imported.
import { useEffect, useMemo, useSyncExternalStore } from "react";
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
export function useMcp(url: string, options: ClientOptions & { autoConnect?: boolean } = {}): UseMcpResult {
  // Options are read once per URL, like a connection config.
  const store = useMemo(() => createMcpStore(url, options), [url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (options.autoConnect !== false) store.connect();
    return () => { store.disconnect(); };
  }, [store]); // eslint-disable-line react-hooks/exhaustive-deps
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return {
    ...state,
    client: store.client,
    connect: store.connect,
    disconnect: store.disconnect,
    refresh: store.refresh,
    callTool: store.client.callTool.bind(store.client),
  };
}

export { createMcpStore };
export type { McpState, McpStore };
