# Sky Atlas Portal

A read-only viewer for the [Sky Atlas](https://sky-atlas.io) governance document.

The portal fetches the canonical Atlas markdown from GitHub, parses it into a navigable tree, and renders it as an interactive web application. No database required.

## Quick Start

```bash
npm install
npm run dev
```

The app starts at [http://localhost:3000](http://localhost:3000). The Atlas viewer is at `/atlas`.

### Local development against a local Atlas (no GitHub)

By default, even in dev the app fetches the Atlas from GitHub on each cold start. To render from a local copy instead — useful for offline work or to avoid spending GitHub API rate limit — set `ATLAS_LOCAL_CONTENT` (e.g. in `.env.local`):

```bash
# A local checkout of the atlas repo (point at the repo root or its content/ dir):
ATLAS_LOCAL_CONTENT=/abs/path/to/next-gen-atlas/content

# ...or a single pre-composed monolith markdown file:
# ATLAS_LOCAL_CONTENT=/abs/path/to/sky-atlas.md
```

A directory is composed exactly like the GitHub tarball (it must contain the `A/`, `NR/` document tree); a file is read verbatim and must already be in the composed monolith format (see [`docs/ATLAS_MARKDOWN_SYNTAX.md`](./docs/ATLAS_MARKDOWN_SYNTAX.md)). The vendored fixture at `tests/fixtures/atlas-content` works as a quick target. The override is ignored when `NODE_ENV=production`.

## How It Works

1. At build time (or on request), the app fetches the Atlas markdown file from a GitHub repository.
2. A markdown parser (`atlas-markdown-importer.ts`) converts the markdown into a structured JSON tree (the "Export Tree").
3. The Next.js app renders the tree as a searchable, filterable, hierarchical viewer.

The Atlas markdown follows a strict format documented in [`docs/ATLAS_MARKDOWN_SYNTAX.md`](./docs/ATLAS_MARKDOWN_SYNTAX.md). Each document has a type, number, name, UUID, and content. The hierarchy is encoded in document numbers (e.g., `A.1.2.3`) and described in [`docs/ATLAS_DOCUMENT_NUMBERING_RULES.md`](./docs/ATLAS_DOCUMENT_NUMBERING_RULES.md).

## Search

Search opens with **Cmd/Ctrl+K** or **/** (Cmd/Ctrl+F is the browser's find again) and
closes with the X or a click outside; Escape is deliberately ignored while working in it.
Results are grouped as Exact, Similar (semantic), Partial and Related. Query syntax:
`type:Annotation`, `in:A.1.2`, `title:word`, `"phrase"`, `'CaseSensitive'`, `-exclude`,
and a UUID prefix jumps straight to a document.

Search runs from prebuilt, hash-pinned artifacts that must be refreshed whenever the
Atlas changes. See [`docs/SEARCH_ARTIFACTS.md`](./docs/SEARCH_ARTIFACTS.md).

## API Endpoints

The portal exposes the Atlas in multiple formats:

| Endpoint              | Format   | Description                                                          |
| --------------------- | -------- | -------------------------------------------------------------------- |
| `/api/atlas.json`     | JSON     | Structured tree of all Atlas documents                               |
| `/api/atlas.md`       | Markdown | Complete Atlas as a single markdown file                             |
| `/api/atlas.yaml`     | YAML     | Same structure as JSON, in YAML format                               |
| `/api/search/rewrite` | JSON     | Explicit Atlas-vocabulary query rewrite (disabled unless configured) |

## Scripts

```bash
# Validate an Atlas markdown file
npx tsx scripts/validate-atlas-markdown.ts [path/to/atlas.md]

# Validate an Atlas JSON file
npx tsx scripts/validate-atlas-json.ts [path/to/atlas.json]
```

## Environment Variables

| Variable                       | Required                                           | Description                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                 | No                                                 | GitHub personal access token for higher API rate limits                                                                                                                                                                    |
| `ATLAS_LOCAL_CONTENT`          | No                                                 | Dev-only. Path to a local Atlas content tree or composed `.md` file to render instead of fetching from GitHub (see [Quick Start](#local-development-against-a-local-atlas-no-github)). Ignored when `NODE_ENV=production`. |
| `ANTHROPIC_API_KEY`            | For query rewriting with the Anthropic provider    | Server-held. Never sent to the browser. The answer feature is OpenAI-only.                                                                                                                                                 |
| `QUERY_REWRITE_ENABLED`        | No                                                 | Set to the exact string `true` to enable the paid `/api/search/rewrite` route. It fails closed otherwise.                                                                                                                  |
| `NEXT_PUBLIC_SEARCH_MODE`      | No                                                 | Search execution default, inlined at build time: `auto` (default: device detection), `local`, or `low-memory` (query model and document vectors stay server-side; the modal reports the mode but has no user switch).      |
| `NEXT_PUBLIC_SEARCH_EMBEDDER`  | No                                                 | Legacy alias: `server` is equivalent to `NEXT_PUBLIC_SEARCH_MODE=low-memory`. Inlined at build time.                                                                                                                       |
| `OPENAI_API_KEY`               | For rewriting and answers with the OpenAI provider | Server-held. Never sent to the browser.                                                                                                                                                                                    |
| `QUERY_REWRITE_PROVIDER`       | No                                                 | `openai` (default) or `anthropic`; selects the rewrite provider and key. Answers require `openai`.                                                                                                                         |
| `SEARCH_ANSWERS_ENABLED`       | No                                                 | Set to the exact string `true`, with the OpenAI provider and key, to enable the answer feature. Off otherwise.                                                                                                             |
| `SEARCH_ANSWER_CONTEXT_POLICY` | No                                                 | Answer context policy; unknown values fall back to `full-document`.                                                                                                                                                        |
| `TRANSFORMERS_CACHE_DIR`       | No                                                 | Where the artifact build scripts cache the embedding model (default `.cache/transformers`).                                                                                                                                |

The rewrite endpoint has same-origin checks, bounded streaming request bodies, and bounded
per-client/instance rate limiting. The Ask control is hidden unless the rewrite flag and a
provider key are configured.
For a multi-instance public deployment, retain those guards and add a distributed
platform-level rate limit before enabling it.

The low-memory dense endpoint applies the same origin/body and process-local admission
guards to CPU-heavy inference. A multi-instance deployment should also apply a distributed
platform-level limit to `/api/search/dense`.

## Tech Stack

- [Next.js](https://nextjs.org/) (App Router)
- TypeScript
- [HeroUI](https://heroui.com/) + Tailwind CSS
- [markdown-it](https://github.com/markdown-it/markdown-it) for rendering, with [highlight.js](https://highlightjs.org/) syntax highlighting for fenced code blocks (GitHub light/dark theme; includes Solidity)
- [Vitest](https://vitest.dev/) for testing

## Testing

```bash
npm test              # watch mode
npm run test:run      # single run
npm run test:coverage # coverage report
```

## Documentation

Docs relevant to the Atlas format and parsing:

- [`docs/ATLAS_MARKDOWN_SYNTAX.md`](./docs/ATLAS_MARKDOWN_SYNTAX.md) -- Complete syntax specification for the Atlas markdown format
- [`docs/ATLAS_MARKDOWN_IMPORT_EXPORT.md`](./docs/ATLAS_MARKDOWN_IMPORT_EXPORT.md) -- How the import/export pipeline works
- [`docs/ATLAS_DOCUMENT_NUMBERING_RULES.md`](./docs/ATLAS_DOCUMENT_NUMBERING_RULES.md) -- Hierarchical document numbering system
- [`docs/NEEDED_RESEARCH.md`](./docs/NEEDED_RESEARCH.md) -- Positioning rules for Needed Research documents in markdown

## License

Apache-2.0 -- see [LICENSE](./LICENSE).
