# mcp-lite-browser

A **zero-dependency MCP client for the browser** over **Streamable HTTP** (MCP spec 2025-11-25), plus a minimal
**MCP Apps host bridge** — in one ~190-line ES module.

Built for the Alexa+ track of the Build, Ship, Shape hackathon, where self-hosted MCP servers are demoed through a
web page that acts as an MCP client. Official SDKs target Node bundlers; this drops into a `<script type="module">`
with no build step.

## Features
- `initialize` handshake with protocol-version negotiation, then `notifications/initialized`
- Sends `MCP-Protocol-Version` and `Mcp-Session-Id` headers on follow-up requests; `DELETE` on close
- Handles both `application/json` and `text/event-stream` (SSE) responses
- Helpers: `listTools`, `callTool`, `listResources`, `readResource`, `listPrompts`, `getPrompt`
- `onTraffic` hook to build an inspector of every JSON-RPC message
- `AppBridge`: renders a `ui://` MCP App (`text/html;profile=mcp-app`) in a sandboxed iframe, answers
  `ui/initialize`, delivers `ui/notifications/tool-input` / `tool-result`, and proxies the view's `tools/call`
  and `resources/read` to the server (SEP-1865, spec 2026-01-26)

## Usage
```html
<script type="module">
  import { McpHttpClient, AppBridge } from "./src/index.js";
  const client = new McpHttpClient("/mcp", { protocolVersion: "2025-11-25" });
  await client.connect();
  const { tools } = await client.listTools();
  const result = await client.callTool("start_drill", { learner_id: "lan" });

  // Render the tool's MCP App, if it declares one
  const uri = tools.find((t) => t.name === "start_drill")._meta?.ui?.resourceUri;
  const html = (await client.readResource(uri)).contents[0].text;
  const bridge = new AppBridge(document.querySelector("iframe"), { client });
  bridge.load(html); bridge.sendToolInput({ learner_id: "lan" }); bridge.sendToolResult(result);
</script>
```
CORS: serve the page from the same origin as the MCP server, or enable CORS on the server.

## Tests
```bash
npm test   # node --test, no dependencies (8 tests: SSE parsing, handshake + tools over JSON and over SSE, JSON-RPC errors, request ids, and the AppBridge: queued notifications, proxied `tools/call` with an allow-list, safe `ui/open-link`)
```

## Used by
[SpeakLoop](https://github.com/ducvuathuduc/speakloop) — an Alexa+ English speaking coach.

## License
MIT © 2026 Huỳnh Diệu Thành
