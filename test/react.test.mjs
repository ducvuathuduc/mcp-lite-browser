import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useMcp } from "../dist/react.js";

test("useMcp renders with the initial idle state (SSR-safe, no network during render)", () => {
  let fetched = false;
  let seen;
  function App() {
    const mcp = useMcp("http://example.test/mcp", { fetch: async () => { fetched = true; return new Response("", { status: 500 }); } });
    seen = mcp;
    return createElement("p", null, `${mcp.status}:${mcp.tools.length}`);
  }
  assert.equal(renderToString(createElement(App)), "<p>idle:0</p>");
  assert.equal(fetched, false);
  assert.equal(typeof seen.callTool, "function");
  assert.equal(typeof seen.connect, "function");
});
