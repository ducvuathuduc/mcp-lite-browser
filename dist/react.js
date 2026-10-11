// React binding: `useMcp(url, options)`. React is a peer dependency; nothing else is imported.
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createMcpStore } from "./store.js";
/**
 * Connect to an MCP server and keep its tools, resources and prompts in React state.
 *
 *   const { status, tools, callTool } = useMcp("https://example.com/mcp");
 */
export function useMcp(url, options = {}) {
    // Options are read once per URL, like a connection config.
    const store = useMemo(() => createMcpStore(url, options), [url]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (options.autoConnect !== false)
            store.connect();
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
