# Landing for developers: real code, and where to start

Date: 2026-10-18. Branch `feat/landing-developers-redesign`. Component: `src/components/landing/BuildOnIt.tsx`.
Follows `2026-10-08-landing-motion-design.md` M3, which typed each snippet into a terminal.

## Why

A UI/UX review (Codex, about 8.1/10) found the section attractive but vague. It did not say what a developer can build,
how fast they can start, or that the controls still hold; the typing terminal looked decorative; and the copy overlapped
the integrations just above it.

## Decisions

- **D1 — the heading stays,** "Runs where you already work.", and the copy says who it is for: builders connecting
  their own applications through the REST API, the TypeScript SDK or the MCP server, with the same payment controls as
  the console. The integrations above are for business teams.
- **D2 — three benefits, small.**
  - "Build on the API": the operations a key reaches.
  - "Controls still apply": every check, and "The API never approves or pays" (the create-invoice operation's own
    words; the MCP guide's "no tool approves or pays").
  - "Every action on record": each write is signed with the key that made it, and the chain verifies from code.

  Each is an icon and two lines in the left column, not cards.
- **D3 — one way to start.** **Read developer docs** opens the quickstart, from no key to reading a workspace's ledger.
  **View on GitHub** opens the repository, secondary. Webhooks, the CLI and the GitHub app are one line under them.
- **D4 — real snippets, static.** The API, the SDK and MCP, one tab each, on the existing tabs.
  - **API:** two reads with the quickstart's request shape, the held invoices with their reasoning and the treasury. Both
    need a read-only key.
  - **SDK:** the guide's client, `invoices.create` with an idempotency key, and `ledger.verify`.
  - **MCP:** the MCP guide's `.mcp.json` for Claude Code.

  GitHub's `/bounty` tab left: the GitHub app is listed with the integrations now. Nothing is typed out: the snippet is
  there whole, highlighted, so the panel reads as a tool rather than a show, and reduced motion changes nothing but the
  tab marker's glide.
- **D5 — highlighting without a dependency.** `build/highlight.ts` reads bash, TypeScript and JSON into tokens that
  spell each line exactly (tested). Each token colour is at least 4.5:1 on the panel. Shiki stays the docs' highlighter,
  on the server; the landing's client bundle carries a few hundred lines instead.
- **D6 — the panel holds still.** Every snippet's code area is as tall as the longest. A long line scrolls inside the
  code, which takes focus so a keyboard can scroll it. The copy button is named for its tab, copies exactly the code, and
  says Copied, with the site's toast; a failed copy says to select the text.

## Sizes

On the dev server against the live page:
- desktop: 744 px (was 697);
- tablet: about 1,150 px (1,007), with the benefits three across;
- mobile: 1,420 px (1,193).

## Tests

`tests/landing-build-on-it.test.tsx` holds:
- the highlighter, which puts every line back together and classifies each kind;
- each snippet, against the OpenAPI operations and their parameters, the SDK guide's lines and the MCP guide's JSON;
- that no snippet holds a key;
- that each link has its guide;
- the tab semantics and the copy button's name;
- the heading, the benefits and both actions.
