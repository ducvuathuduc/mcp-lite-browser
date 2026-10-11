<div align="center">

<img src="assets/logo.svg" width="112" height="112" alt="mcp-lite-browser logo">

# mcp-lite-browser

**The 8 kB MCP client for the browser: Streamable HTTP, OAuth 2.1, resumable SSE, elicitation, sampling and an MCP Apps host, with zero dependencies.**

[![CI](https://github.com/ducvuathuduc/mcp-lite-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/ducvuathuduc/mcp-lite-browser/actions/workflows/ci.yml)
[![Size](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fducvuathuduc%2Fmcp-lite-browser%2Fmain%2Fbadges%2Fsize.json)](dist/size.json)
[![Tests](https://img.shields.io/badge/tests-54%20passed-2ea44f)](#-testing)
[![Dependencies](https://img.shields.io/badge/dependencies-0-0ea5e9)](package.json)
[![TypeScript](https://img.shields.io/badge/types-included-3178C6?logo=typescript&logoColor=white)](src)
[![MCP](https://img.shields.io/badge/MCP-2025--11--25-6E56CF)](https://modelcontextprotocol.io/specification/2025-11-25)
[![Release](https://img.shields.io/github/v/release/ducvuathuduc/mcp-lite-browser?color=8b5cf6)](https://github.com/ducvuathuduc/mcp-lite-browser/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)

**[▶ Try the playground](https://ducvuathuduc.github.io/mcp-lite-browser/)** ·
[Quickstart](#-quickstart) ·
[MCP Apps](#%EF%B8%8F-hosting-mcp-apps) ·
[OAuth](#-oauth-21) ·
[CORS](#-cors-and-mcp-session-id) ·
[API](#-api-at-a-glance)

<img src="assets/inspector.gif" width="420" alt="Live MCP traffic inspector built with the onTraffic hook: initialize, tools/list, resources/read and tools/call messages appear as a session runs">

<sub>An MCP traffic inspector built on the <code>onTraffic</code> hook, recorded in
<a href="https://github.com/ducvuathuduc/speakloop">SpeakLoop</a>'s Alexa+ simulator (6× speed).</sub>

</div>

---

## 📏 Why so small matters

The official MCP TypeScript SDK is excellent, but it is built for Node and bundlers. If all you need is a web page
that talks to an MCP server, you pay for a lot you never use.

| | Official SDK client (`@modelcontextprotocol/sdk`) | **mcp-lite-browser** |
|---|---|---|
| Browser bundle, min + gzip | 90,543 B (measured: `Client` + `StreamableHTTPClientTransport`, esbuild, minified) | **8,627 B** (`dist/mcp-lite-browser.min.js`) |
| Runtime dependencies | 17 declared (incl. zod, ajv, express, hono) | **0** |
| `<script type="module">` from a CDN, no bundler | no | **yes** |
| OAuth 2.1 + PKCE in the browser | yes | **yes** (popup flow included) |
| MCP Apps host (render `ui://` views) | no (separate package) | **yes** |
| React hook | no | **yes** (`mcp-lite-browser/react`) |

About **10× smaller**, and a CI size check fails any change that pushes the full bundle past 10 kB.
Smaller entry points: `client.min.js` 3,988 B and `bridge.min.js` 2,680 B (min + gzip).

## ✨ Features

- **Streamable HTTP, spec `2025-11-25`**: protocol-version negotiation, `MCP-Protocol-Version` and `Mcp-Session-Id`
  headers, JSON and SSE responses, `DELETE` on `close()`, transparent re-initialize when a session expires (404).
- **Resumable SSE**: the standalone `GET` stream (`listen`), reconnection with `Last-Event-ID`, the server's `retry:`
  field and back-off.
- **Server-to-client requests**: elicitation (form and URL mode), sampling, roots, `ping`, plus
  `setRequestHandler` for anything else.
- **Requests done right**: timeouts, `AbortSignal` cancellation (`notifications/cancelled`), progress callbacks,
  pagination helpers (`listAllTools`, `listAllResources`, `listAllPrompts`).
- **Full client surface**: tools, resources, resource templates, subscriptions, prompts, completion, logging level.
- **OAuth 2.1**: protected-resource and authorization-server discovery (RFC 9728 / 8414), PKCE S256, dynamic
  registration or Client ID Metadata Documents, RFC 8707 resource indicators, refresh tokens, step-up on
  `insufficient_scope`. Or bring a static token with `bearer()`.
- **MCP Apps host**: `AppBridge` renders a tool's `ui://` view in a sandboxed iframe with the CSP the spec
  prescribes, enforces tool `visibility`, and handles `ui/message`, `ui/update-model-context`, display modes, host
  context changes, links and teardown.
- **Framework friendly**: a tiny observable store (`createMcpStore`) and a React hook (`useMcp`); works with Svelte,
  Vue or plain JS through the store.
- **TypeScript types** shipped, ESM only, `sideEffects: false`. Still usable with no build step.
- **Inspector hook**: `onTraffic(direction, message, meta)` sees every JSON-RPC message.

## 🚀 Quickstart

### CDN (no install, no bundler)

```html
<script type="module">
  import { McpClient } from "https://cdn.jsdelivr.net/gh/ducvuathuduc/mcp-lite-browser@v0.2.0/dist/mcp-lite-browser.min.js";

  const client = new McpClient("https://example.com/mcp");
  const init = await client.connect();
  console.log(`connected to ${init.serverInfo.name}, MCP ${client.negotiatedVersion}`);

  const tools = await client.listAllTools();
  const result = await client.callTool(tools[0].name, {});
  console.log(result.structuredContent ?? result.content);
</script>
```

### npm

The package is not on the npm registry yet; install it from GitHub (the built `dist/` is committed):

```bash
npm install github:ducvuathuduc/mcp-lite-browser#v0.2.0
```

```ts
import { McpClient, McpError } from "mcp-lite-browser";

const client = new McpClient("/mcp", {
  timeout: 30_000,
  onElicit: async ({ message, requestedSchema }) => ({ action: "accept", content: await askUser(message, requestedSchema) }),
});
await client.connect();

const ctrl = new AbortController();
try {
  const res = await client.callTool("long_job", { n: 10 }, { signal: ctrl.signal });
  if (res.isError) console.warn("tool failed", res.content);
} catch (e) {
  if (e instanceof McpError) console.error(e.code, e.message);
}
```

> v0.1's `McpHttpClient` name still works: it is an alias of `McpClient`.

### React

```tsx
import { useMcp } from "mcp-lite-browser/react";

export function Tools() {
  const { status, tools, error, callTool } = useMcp("https://example.com/mcp");
  if (status === "connecting") return <p>Connecting…</p>;
  if (status === "failed") return <p>Error: {error?.message}</p>;
  return (
    <ul>
      {tools.map((t) => (
        <li key={t.name}>
          <button onClick={() => callTool(t.name, {})}>{t.name}</button>
        </li>
      ))}
    </ul>
  );
}
```

`tools`, `resources` and `prompts` refresh automatically on `list_changed` notifications. Outside React, use
`createMcpStore(url)` and its `subscribe` / `getSnapshot`.

## 🖼️ Hosting MCP Apps

An MCP App is an HTML view a server exposes as a `ui://` resource (`text/html;profile=mcp-app`); tools point at it
through `_meta.ui.resourceUri`. `AppBridge.open` reads the view, calls the tool, and feeds the view its input and
result:

```ts
import { McpClient, AppBridge, isModelVisible } from "mcp-lite-browser";

const client = new McpClient("/mcp");
await client.connect();
const tools = await client.listAllTools();

const { bridge, result } = await AppBridge.open(document.querySelector("iframe")!, client, "show_chart", { days: 7 }, {
  tools,                                              // enforces _meta.ui.visibility (app-only tools)
  hostContext: { theme: "dark", displayMode: "inline" },
  onSize: (h) => (bridge.iframe.style.height = `${h}px`),
  onMessage: ({ role, content }) => chat.add(role, content),   // ui/message from the view
  onUpdateModelContext: (ctx) => agent.setContext(ctx),
});

// Give the model only the tools it should see
agent.setTools(tools.filter(isModelVisible));
```

The view runs in an `allow-scripts`-only iframe (opaque origin), with a CSP built from its declared
`_meta.ui.csp` domains. `ui/open-link` opens only http(s) URLs unless you supply `onOpenLink`. Call
`bridge.teardown()` before removing the view so it can save state.

## 🔐 OAuth 2.1

```ts
import { McpClient, oauth } from "mcp-lite-browser";

const client = new McpClient("https://mcp.example.com/mcp", {
  auth: oauth({
    redirectUri: location.origin + "/callback.html",
    clientMetadataUrl: location.origin + "/oauth-client.json",  // used when the AS supports CIMD
    clientName: "My MCP app",                                  // used for dynamic registration otherwise
  }),
});
await client.connect();   // first 401 → discovery → popup consent → tokens → request retried
```

`callback.html` only needs:

```html
<script type="module">
  import { completeOAuthPopup } from "https://cdn.jsdelivr.net/gh/ducvuathuduc/mcp-lite-browser@v0.2.0/dist/mcp-lite-browser.min.js";
  completeOAuthPopup();
</script>
```

Tokens live in `sessionStorage` by default (pass `storage` to change it). For a static token use
`auth: bearer("…")`. The playground ships a working [`callback.html`](playground/callback.html) and
[`oauth-client.json`](playground/oauth-client.json).

## 🌐 CORS and `Mcp-Session-Id`

A browser can only talk to an MCP server on another origin if the server allows it. Your server must:

- answer the `OPTIONS` preflight and send `Access-Control-Allow-Origin` for your page's origin;
- allow the request headers `Content-Type`, `Accept`, `Authorization`, `MCP-Protocol-Version`, `Mcp-Session-Id`
  and `Last-Event-ID` (`Access-Control-Allow-Headers`);
- allow the methods `GET`, `POST`, `DELETE`;
- **expose `Mcp-Session-Id`** (`Access-Control-Expose-Headers: Mcp-Session-Id, WWW-Authenticate`). Without it the
  browser hides the session header, the client never learns the session id, and stateful servers reject every
  request after `initialize`.

Same-origin pages (server and page behind one host) need none of this.

## 🎮 Playground

**[ducvuathuduc.github.io/mcp-lite-browser](https://ducvuathuduc.github.io/mcp-lite-browser/)** is an MCP inspector
running entirely on this library: connect to any CORS-enabled server (with OAuth), browse and call tools, read
resources, render MCP Apps, answer elicitations, and watch live traffic. A built-in demo server works offline. Run
it locally with `npm run build && npm run playground`.

## 📚 API at a glance

| Export | What it is |
|---|---|
| `McpClient` (alias `McpHttpClient`) | The client. Options: `protocolVersion`, `clientInfo`, `capabilities`, `fetch`, `headers`, `auth`, `onTraffic`, `timeout`, `maxRetries`, `reconnectDelay`, `reconnectOnSessionExpired`, `apps`, `listen`, `onElicit`, `onSampling`, `roots` |
| `McpError` | JSON-RPC or HTTP error with `code` and `data` |
| `bearer(token)` · `oauth(options)` / `OAuthProvider` | Auth providers |
| `completeOAuthPopup`, `pkce`, `discoverProtectedResource`, `discoverAuthorizationServer`, `parseWwwAuthenticate`, `canonicalResource` | OAuth building blocks |
| `AppBridge`, `buildCsp`, `injectCsp`, `decodeUiResource`, `getUiResourceUri`, `isModelVisible` | MCP Apps host |
| `createMcpStore` · `useMcp` (`mcp-lite-browser/react`) | State for UI frameworks |
| `SseParser`, `parseSse` | SSE parsing |

Full signatures are in the shipped `.d.ts` files ([`src/`](src) is the readable source).

## ✅ Testing

```bash
npm ci
npm run build && npm run typecheck && npm test && npm run size
```

54 tests with `node --test`: unit tests for the client, OAuth, the MCP Apps bridge, the store and the React hook,
plus 17 end-to-end conformance tests against a real server built with the official MCP TypeScript SDK over HTTP.
CI runs them on Node 18, 20 and 22.

## 🌟 Used by

<a href="https://github.com/ducvuathuduc/speakloop"><img src="https://raw.githubusercontent.com/ducvuathuduc/speakloop/main/assets/logo.svg" width="40" align="left" alt="SpeakLoop logo"></a>

**[SpeakLoop](https://github.com/ducvuathuduc/speakloop)**: an Alexa+ English speaking coach that remembers you.
Its browser simulator uses this library for every MCP message and to render its MCP App cards.

<br clear="left">

<p align="center"><img src="assets/speakloop-demo.gif" width="720" alt="SpeakLoop's Alexa+ simulator running on mcp-lite-browser: chat on the left, MCP App cards in the middle, MCP traffic on the right"></p>

Using it somewhere? Open a PR to add your project here.

## 🤝 Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](SECURITY.md).
Release history: [CHANGELOG.md](CHANGELOG.md).

## 📄 License

[MIT](LICENSE) © 2026 Huỳnh Diệu Thành

## 🙏 Acknowledgements

- [Model Context Protocol](https://modelcontextprotocol.io): the Streamable HTTP transport, the authorization spec
  and the [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps)
- The [official MCP SDKs](https://github.com/modelcontextprotocol), whose behaviour this library follows and tests against
- Built during *Build, Ship, Shape: Amazon Developer Hackathon 2026*
