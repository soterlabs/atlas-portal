# Contributing to Atlas Portal

This repository contains the source code for [sky-atlas.io](https://sky-atlas.io), the human-readable viewer for the [Sky Atlas](https://github.com/sky-ecosystem/next-gen-atlas) maintained by [Soter Labs](https://soterlabs.com). The portal renders the canonical Atlas Markdown as an interactive, navigable web app.

Contributions are welcome, with the caveat that review depends on Soter Labs team availability and that acceptance depends on alignment with the team's strategic priorities for the portal. Not every PR will be reviewed or merged, even good ones — please open an issue to gauge interest before investing significant time in a larger change.

## Scope

The right place to contribute depends on what you're trying to change:

- **Atlas content (governance documents)**: edits go through the [Atlas governance process](https://forum.skyeco.com/), not this repo. The canonical Atlas Markdown lives at [`sky-ecosystem/next-gen-atlas`](https://github.com/sky-ecosystem/next-gen-atlas).
- **Portal bugs or display issues**: open an issue here with a clear reproduction (URL, browser, steps, expected vs. actual).
- **Portal features**: feel free to open an issue to discuss larger changes before sending a PR. Atlas Portal is a viewer, not an editor — feature scope is intentionally focused on browsing, search, and navigation.
- **Security vulnerabilities**: please use [GitHub Private Vulnerability Reporting](https://github.com/soterlabs/atlas-portal/security/advisories/new) rather than opening a public issue.

## Local development

Requirements: Node.js (version pinned in [`.nvmrc`](./.nvmrc)).

```bash
npm install
npm run dev
```

The app starts at <http://localhost:3000>. The Atlas viewer is at `/atlas`.

## Pre-PR checklist

Before opening a PR, please make sure these pass locally:

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:run
```

CI runs the same four checks on every PR. PRs with failing CI will not be reviewed until the failures are addressed.

## Architecture

For a deeper read on how the portal works, see [`AGENTS.md`](./AGENTS.md) — it documents the data flow, key files, and conventions.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
