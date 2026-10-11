// A framework-agnostic reactive store around McpClient. It follows the Svelte store contract
// (`subscribe(fn)` calls `fn` immediately and returns an unsubscribe function), so it works as-is in Svelte,
// with `useSyncExternalStore` in React (see `mcp-lite-browser/react`), and with a `shallowRef` in Vue.
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

export function createMcpStore(url: string, options: ClientOptions = {}): McpStore {
  const client = new McpClient(url, options);
  let state: McpState = { status: "idle", tools: [], resources: [], prompts: [], serverInfo: null, error: null };
  const subs = new Set<(s: McpState) => void>();
  const set = (patch: Partial<McpState>) => { state = { ...state, ...patch }; subs.forEach((fn) => fn(state)); };

  const refresh = async () => {
    const caps = client.serverCapabilities || {};
    const [tools, resources, prompts] = await Promise.all([
      caps.tools ? client.listAllTools() : [],
      caps.resources ? client.listAllResources() : [],
      caps.prompts ? client.listAllPrompts() : [],
    ]);
    set({ tools, resources, prompts });
  };
  const watch = (method: string, fn: () => Promise<void>) => client.on(method, () => { fn().catch((error) => set({ error })); });
  watch("notifications/tools/list_changed", async () => set({ tools: await client.listAllTools() }));
  watch("notifications/resources/list_changed", async () => set({ resources: await client.listAllResources() }));
  watch("notifications/prompts/list_changed", async () => set({ prompts: await client.listAllPrompts() }));

  return {
    client,
    subscribe(fn) { subs.add(fn); fn(state); return () => { subs.delete(fn); }; },
    getSnapshot: () => state,
    async connect() {
      if (state.status === "connecting" || state.status === "ready") return;
      set({ status: "connecting", error: null });
      try {
        const init = await client.connect();
        await refresh();
        set({ status: "ready", serverInfo: init.serverInfo });
      } catch (e: any) {
        set({ status: "failed", error: e instanceof Error ? e : new Error(String(e)) });
      }
    },
    async disconnect() { await client.close(); set({ status: "closed" }); },
    refresh,
  };
}
