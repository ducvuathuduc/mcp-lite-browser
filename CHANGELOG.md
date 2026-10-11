# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-10-11

Rewritten in TypeScript. Still zero dependencies: the full bundle is 8,627 B min+gzip (budget 10 kB, checked in CI).

### Added
- `McpClient` (v0.1's `McpHttpClient` stays as an alias): request timeouts, `AbortSignal` cancellation with
  `notifications/cancelled`, progress callbacks, pagination helpers (`listAllTools`, `listAllResources`,
  `listAllPrompts`), resource templates and subscriptions, completion, logging level, `ping`.
- Standalone `GET` SSE stream (`listen`), resumption with `Last-Event-ID`, `retry:` handling and back-off;
  POST streams that drop are resumed too.
- Server-to-client requests: elicitation (form and URL mode), sampling, roots, plus `setRequestHandler` and `on()`
  for notifications. Transparent re-initialize when the server expires a session (404).
- OAuth 2.1 (`oauth()` / `OAuthProvider`): RFC 9728 and RFC 8414 discovery, PKCE S256, dynamic client registration
  or Client ID Metadata Documents, RFC 8707 resource indicators, refresh tokens, step-up on `insufficient_scope`,
  popup flow with `completeOAuthPopup`. Static tokens with `bearer()`.
- MCP Apps host: `AppBridge.open`, CSP built from `_meta.ui.csp`, tool `visibility` enforcement, `ui/message`,
  `ui/update-model-context`, display modes, host-context changes, partial/cancelled tool input, teardown.
- `createMcpStore` and the React hook `useMcp` (`mcp-lite-browser/react`).
- TypeScript types; ESM builds in `dist/` plus CDN bundles (`mcp-lite-browser.min.js`, `client.min.js`,
  `bridge.min.js`).
- Playground: a browser MCP inspector built on the library, deployed to GitHub Pages
  (https://ducvuathuduc.github.io/mcp-lite-browser/).
- 54 tests, including 17 end-to-end conformance tests against a server built with the official MCP TypeScript SDK.
- CI: `npm ci`, build, typecheck, test and size check on Node 18, 20 and 22; Pages deploy workflow.

### Changed
- Source moved from `src/index.js` to TypeScript in `src/`; import from `dist/` (or the package root) instead.
- `fetchImpl` is now `fetch` (`fetchImpl` still accepted).

### Removed
- The v0.1 JavaScript tests, replaced by the `.mjs` suite.

## [0.1.0] - 2026-10-11

First public release.

### Added
- `McpHttpClient`: MCP client over **Streamable HTTP** for the browser (spec `2025-11-25`): `initialize` with
  protocol-version negotiation, `notifications/initialized`, `MCP-Protocol-Version` and `Mcp-Session-Id` headers,
  `DELETE` on `close()`, JSON and SSE (`text/event-stream`) responses.
- Helpers: `listTools`, `callTool`, `listResources`, `readResource`, `listPrompts`, `getPrompt`, plus raw
  `request` / `notify`.
- `onTraffic` hook for building an inspector of every JSON-RPC message.
- `McpError` carrying JSON-RPC `code` and `data`; `parseSse` helper.
- `AppBridge`: minimal **MCP Apps** host (SEP-1865) that renders a `ui://` view in an `allow-scripts`-only
  sandboxed iframe, answers `ui/initialize`, queues and delivers tool input/result notifications, proxies
  `tools/call` (with an `allowTool` allow-list) and `resources/read`, and opens only http(s) links.
- 8 tests with `node --test` and no dependencies; GitHub Actions CI on Node 18, 20 and 22.
- Example page (`examples/index.html`), contributing guide, code of conduct, security policy, issue and PR templates.

[Unreleased]: https://github.com/ducvuathuduc/mcp-lite-browser/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/ducvuathuduc/mcp-lite-browser/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ducvuathuduc/mcp-lite-browser/releases/tag/v0.1.0
