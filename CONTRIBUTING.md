# Contributing to mcp-lite-browser

Thanks for taking the time to help! This project is small and young, so every issue, idea and pull request
matters. By taking part you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug** with the [bug report form](https://github.com/ducvuathuduc/mcp-lite-browser/issues/new?template=bug_report.yml).
- **Suggest a feature** with the [feature request form](https://github.com/ducvuathuduc/mcp-lite-browser/issues/new?template=feature_request.yml).
- **Improve the docs**: typos, clearer examples and translations are all welcome.
- **Send code**: look for issues labelled `good first issue` or `help wanted`, or pick something below.

Good first contributions:

- Server-initiated requests over SSE (sampling, elicitation) and GET stream resumption
- Request cancellation and timeouts
- TypeScript declaration file (`index.d.ts`) without adding a build step
- More MCP Apps host methods (display modes, theme updates)

## Development setup

```bash
git clone https://github.com/ducvuathuduc/mcp-lite-browser && cd mcp-lite-browser
npm test        # node --test, Node 18+, no install step: there are no dependencies
```

## Pull request workflow

1. Fork the repo and create a branch from `main` (`feat/short-name` or `fix/short-name`).
2. Make your change with tests. Keep pull requests focused: one topic per PR.
3. Run the test suite locally; CI runs the same command on every push and pull request.
4. Write a clear commit message in the imperative mood ("Add …", "Fix …"). [Conventional Commits](https://www.conventionalcommits.org/) prefixes are welcome but not required.
5. Open the PR and fill in the template. A maintainer will review it as soon as possible.

## Style

- Zero runtime dependencies, no build step: `src/index.js` must keep working as a plain `<script type="module">` import.
- Keep the module small and readable; prefer clarity over cleverness.
- Follow the MCP spec text (Streamable HTTP, MCP Apps) and link the section you implement in the PR.
- Every behaviour change needs a test in `test/` using the fake `fetch` / fake `window` helpers.

## Security

Please do **not** open public issues for security problems. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
