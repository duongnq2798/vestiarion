# Docs redesign: navigation, reading surface and the docs' home

Date: 2026-10-16. Branch `feat/docs-redesign`. This builds on `2026-10-11-docs-clarity-design.md`, which it does not
undo: its nav order, callout kinds, numbered steps, screenshots and Markdown views stay. A review compared `/docs` with
the developer docs of Circle and CoinGecko.

## What was wrong

- **The sidebar was a wall of links.** "Everyday work" listed 22 pages in one run, and every section but the API
  reference and webhooks was always open. The section labels were 11 px mono capitals, and long titles wrapped at
  16.5 rem.
- **One cream for everything.** The header, sidebar, page and table of contents all sat on the ground's cream
  (`bg-ground`), so nothing separated them.
- **Weak hierarchy at the top of a page.** A mono section label, a 34 px title, and a reading column of 48 rem (about
  90 characters a line).
- **Callouts that read as empty boxes.** A note was a white box on cream with a thin grey rule.
- **A home that was a list of cards.** No search on the page, and no index of the docs' sections.

## Decisions

- **D1 — The frame.**
  - The page sits on the surface (`bg-surface`, near white), and the sidebar on a quiet panel of the ground
    (`bg-ground/40`) behind a rule.
  - The header keeps the site's wordmark and "Docs" label. It adds a wider search field (18 rem from `lg`), a GitHub
    link from `xl` (the repository is public), and Open console as a secondary button.
  - No new colour tokens: the brand's own surface, ground, line, ink and agent blue, so the docs stay the same product
    as the console and the landing page.
- **D2 — The nav, regrouped.**
  - Sections: Get started (overview, first decision, workspace, shadow mode, go live), Pay bills, Plan and report, Get
    paid, Trust and controls, Connect your tools, Developers, then the API reference, webhooks and the changelog.
  - Every page keeps its address, and the pager's learning order still runs from the first decision to going live,
    then paying.
  - Long sections split into short runs under `NavPage.group`, which only the sidebar draws:
    - Pay bills: Pay, Add bills, Follow a payment, For the people you pay.
    - Connect your tools: Accounting, Sales and CRM, Delivered work, Team chat, Your browser.
    - Developers: Start, Guides, Conventions, AI agents.
  - A section groups all its pages or none, and a group is one run.
- **D3 — A sidebar that shows one section at a time.**
  - Every section is a `<details>`, so it works before any script runs, with a chevron and its page count. The one
    holding the page being read is open.
  - A section opened by hand stays open as pages change, since the sidebar lives in the docs layout. Moving to a page
    in a closed section opens it.
  - Pages sit on a guide line, the current one marked by a 2 px agent-blue bar, its weight and its colour, and
    `aria-current="page"`.
  - The current page is scrolled into view inside the sidebar (or the phone's drawer).
  - The changelog, a one-page section, is a link of its own.
  - Rows are 40 px on a touch screen and 32 px from `lg`.
- **D4 — The page.**
  - A breadcrumb (Docs › section), Copy page and the Markdown view, then the title at 38 px and a lead at 18 px.
  - The column is 44 rem (about 75 characters a line), with "Edit this page on GitHub" under every page written in
    MDX (`/edit/main/content/docs/<slug>.mdx`), then the pager.
  - "On this page" from `xl`, only when a page has two sections or more, with a sans-serif heading and the current
    section marked by a 2 px bar.
- **D5 — The docs' home.** `DocsHomeHero` replaces the title block:
  - what the docs are for, in one line;
  - a wide search button that opens the same dialog as the header, with its shortcut;
  - See your first decision, and Developer quickstart.

  The MDX then has:
  - the overview paragraph and the testnet and mainnet note;
  - six popular workflows: first decision, shadow mode, go live, controls, accounting tools, Chrome capture;
  - `<TopicIndex />`: each section of the nav with its first four pages and how many more. It is built from `DOCS_NAV`,
    so it never names a page that does not exist, and an odd last card spans the row;
  - developer resources: quickstart, API, SDK, webhooks, AI integration, the repository;
  - the videos, what you can build, and what the API is.

  Cards may carry an `icon` from one set of line icons. A name outside the set fails the build.
- **D6 — Callouts with their own tint.** Note in the agent's lightest blue, tip in proof green, important in agent
  blue, warning in held amber, real money in refused red. Each has its icon, and its label in words beside the title
  (`role="note"`), so a kind never rests on colour alone. A callout with no kind is drawn as before.
- **D7 — A workflow figure.**
  - `<Flow caption>` with `<FlowStep title>`: the steps on a line with dots, not numbers, so it is never read as the
    guide's own numbered steps.
  - It is an ordered list, and a numbered list in the `.md` view.
  - It is used only for a flow the guide already describes. The bank payout guide's is: a bill to the vendor, the agent
    decides, a person approves, BlindPay pays out, the vendor's bank. Its caption says that in this version BlindPay's
    development instance runs every payout through its sandbox, so no pesos reach a bank.
  - That guide's notice about the development instance is now Important, not a note.

Kept:
- **Search.** Its index, its dialog, Ctrl K or ⌘K, results by page and heading, and the empty state were already sound.
  Only its triggers changed.
- **Code blocks.** shiki, server-highlighted, with the language and a copy button.
- **Tables, screenshots and videos.**

Not done:
- **A dark theme.** The site has none to match.
- **Section landing pages.** A breadcrumb's section is plain text, since no page exists to link it to.

## Checked

`tests/docs-redesign.test.tsx`:
- the sidebar opens only the section holding the page (Pay bills on a guide, Get started on the home), with group
  headings, page counts and the changelog as a link;
- the breadcrumb and edit link, and no edit link on a generated API page;
- a callout's role and words;
- the flow's list and its Markdown;
- the bank payout guide keeps "a person approves every one", its Important notice and its no-pesos caption;
- the topic index covers every indexed section, in the page and in Markdown;
- card icons come from the set.

`tests/docs-content.test.ts` holds the new sections, pages, groups and the pager's order.

Headless Edge:
- The home, bank payouts, Xero, quickstart and an API reference page at 1440, 1024, 768 and 375 px, with no horizontal
  overflow.
- The phone drawer at 375 and 768 px, opening on the current section.
- Keyboard:
  - Ctrl K opens search with the field focused;
  - "bank payouts" then Enter goes to `/docs/guides/bank-payouts#1-set-up-bank-payouts`;
  - Escape closes the dialog;
  - Enter on a closed section's summary opens it, with the focus ring.

## Polish after the first review (H1–H6)

A second review of the shipped redesign raised six points. Five are taken; one is not.

- **H1 — One section open after a move.** Moving to a page in another section now opens that section alone and closes
  the rest. Within a section, the ones opened by hand stay open. Before, the section left behind stayed open, so two
  could show at once.
- **H2 — The home has no "On this page".** It runs to 64rem for its grids, its prose still held to the 44rem reading
  width.
- **H3 — Workflows first.** The home leads with Popular workflows, Explore by topic and Developer resources, then "How
  Vestiarion works": the overview paragraph and the testnet and mainnet note, moved down from the top.
  - The two grids of cards and the topic index run three to a row from `xl` (`<Cards columns="3">`). A lone last topic
    card spans its row, worked out from the count rather than by CSS that two rules could fight over.
  - Beside the hero from `xl`, "How a bill moves" is a compact `<Flow>` of four steps the product takes, with the guide
    on how payments are controlled:
    1. a bill comes in;
    2. the agent decides and says why;
    3. rules in code check it, and can refuse what the model proposes;
    4. it is paid in USDC on Arc within your limits, or a person decides.
- **H4 — One search field.** On the home, the header's search steps aside for the hero's larger one. Ctrl K or ⌘K opens
  search everywhere.
- **H5 — Calmer group headings.** The sidebar's group headings are sentence case at 12 px, not spaced capitals.
- **H6 — Not taken: folding the groups inside a section.** A group holds one to five pages; folding it would add a
  click for each and save little height once only one section is open.

`tests/docs-redesign.test.tsx` holds:
- the home's order and its three-column grids;
- no table of contents on the home, its widths;
- one search field on the home and the header's elsewhere;
- the hero's four steps, and a titled flow in Markdown;
- the lone last topic card spanning its row.

Headless Edge, at 1440, 1280, 1024, 768 and 375 px:
- the hero's flow card from 1280 px;
- the header's search gone on the home only;
- moving from Pay bills, with Get paid opened by hand, to the Xero guide leaves Connect your tools alone open.
