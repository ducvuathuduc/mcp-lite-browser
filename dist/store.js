// A framework-agnostic reactive store around McpClient. It follows the Svelte store contract
// (`subscribe(fn)` calls `fn` immediately and returns an unsubscribe function), so it works as-is in Svelte,
// with `useSyncExternalStore` in React (see `mcp-lite-browser/react`), and with a `shallowRef` in Vue.
import { McpClient } from "./client.js";
export function createMcpStore(url, options = {}) {
    const client = new McpClient(url, options);
    let state = { status: "idle", tools: [], resources: [], prompts: [], serverInfo: null, error: null };
    const subs = new Set();
    const set = (patch) => { state = { ...state, ...patch }; subs.forEach((fn) => fn(state)); };
    const refresh = async () => {
        const caps = client.serverCapabilities || {};
        const [tools, resources, prompts] = await Promise.all([
            caps.tools ? client.listAllTools() : [],
            caps.resources ? client.listAllResources() : [],
            caps.prompts ? client.listAllPrompts() : [],
        ]);
        set({ tools, resources, prompts });
    };
    const watch = (method, fn) => client.on(method, () => { fn().catch((error) => set({ error })); });
    watch("notifications/tools/list_changed", async () => set({ tools: await client.listAllTools() }));
    watch("notifications/resources/list_changed", async () => set({ resources: await client.listAllResources() }));
    watch("notifications/prompts/list_changed", async () => set({ prompts: await client.listAllPrompts() }));
    return {
        client,
        subscribe(fn) { subs.add(fn); fn(state); return () => { subs.delete(fn); }; },
        getSnapshot: () => state,
        async connect() {
            if (state.status === "connecting" || state.status === "ready")
                return;
            set({ status: "connecting", error: null });
            try {
                const init = await client.connect();
                await refresh();
                set({ status: "ready", serverInfo: init.serverInfo });
            }
            catch (e) {
                set({ status: "failed", error: e instanceof Error ? e : new Error(String(e)) });
            }
        },
        async disconnect() { await client.close(); set({ status: "closed" }); },
        refresh,
    };
}
