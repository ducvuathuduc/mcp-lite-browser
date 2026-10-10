# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/ducvuathuduc/mcp-lite-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ducvuathuduc/mcp-lite-browser/releases/tag/v0.1.0
