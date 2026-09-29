<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Developer docs

A PR that changes `/api/v1` or the webhooks adds an entry to `content/docs/changelog.mdx`: dated, newest first, saying what changed for an integrator.

How the docs are built, and the tests that hold them to the code, are in the "Developer docs" section of `ARCHITECTURE.md`.
