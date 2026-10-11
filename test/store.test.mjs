import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpStore } from "../dist/index.js";
import { startSdkServer } from "./fixtures/sdk-server.mjs";

test("createMcpStore: status transitions, lists, and live refresh on tools/list_changed", async () => {
  const srv = await startSdkServer();
  const store = createMcpStore(srv.url, { listen: true, timeout: 5000 });
  const statuses = [];
  const unsub = store.subscribe((s) => { if (statuses.at(-1) !== s.status) statuses.push(s.status); });
  await store.connect();
  const s = store.getSnapshot();
  assert.equal(s.status, "ready");
  assert.equal(s.serverInfo.name, "sdk-conformance-server");
  assert.ok(s.tools.some((t) => t.name === "echo"));
  assert.ok(s.resources.some((r) => r.uri === "file:///readme.md"));
  assert.ok(s.prompts.some((p) => p.name === "greet"));
  await new Promise((r) => setTimeout(r, 50));
  await store.client.callTool("add_tool");
  for (let i = 0; i < 50 && !store.getSnapshot().tools.some((t) => t.name === "added_later"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(store.getSnapshot().tools.some((t) => t.name === "added_later"), "store refreshed itself");
  await store.disconnect();
  unsub();
  assert.deepEqual(statuses, ["idle", "connecting", "ready", "closed"]);
  await srv.close();
});

test("createMcpStore: failures land in state.error (Svelte-style subscribe gets the value immediately)", async () => {
  const store = createMcpStore("http://127.0.0.1:9/mcp", { fetch: async () => new Response("down", { status: 503 }) });
  let first;
  store.subscribe((s) => { first ??= s; });
  assert.equal(first.status, "idle");
  await store.connect();
  assert.equal(store.getSnapshot().status, "failed");
  assert.match(store.getSnapshot().error.message, /HTTP 503/);
});
