# Landing integrations: the tools grouped by the job they do

Date: 2026-10-16. Branch `feat/integrations-section`. Component: `src/components/landing/Integrations.tsx` (was
`BuiltWith.tsx`).

## Why

"Built on, and works with" was a strip of eleven equal cells, five to a row: Arc and Circle sat beside accounting
software, CRMs, chat apps and the npm SDK at the same weight, each under a "Works with" label, with a 12 px sentence and
"Read the guide". A business visitor could not tell in a glance what Vestiarion connects to, what it is built on, or
why connecting a tool helps; the SDK sat alone on the last row; and Zoho CRM, a connector of its own since #378, was
only a clause in Zoho Books' cell.

A UI/UX review (Codex, from a screenshot) found: weak hierarchy (A), long uneven descriptions (B), the same call to
action on almost every cell (C), small marks and text with a repeated uppercase label (D), the SDK isolated on its own
row (E), and no word on what each connection is for (F).

## Decisions

- **L1 — a section of its own, before the developers'.** Eyebrow "Integrations", the h2 "Keep your tools. Vestiarion
  connects to them.", and one sentence: bills, won deals and finished work come in from the software a business already
  uses, and nothing is paid until it passes its checks. It moved above "For developers", whose h2 is "Runs where you
  already work.": business tools first, then the developer's way in. The heading was chosen not to echo that one.
- **L2 — three groups of three, by job.** Accounting (Xero, QuickBooks Online, Zoho Books), Sales and CRM (HubSpot,
  Pipedrive, Zoho CRM), Work and team chat (Asana, Slack, Telegram). The review suggested 3 / 3 / 2 with Asana under
  sales and operations; that leaves a row of two and puts contractor work beside CRMs. Asana sits with the team's
  chat instead, so every row of three is full; the data's type (`tools` is a tuple of three) holds it. Zoho CRM is shown
  as itself.
- **L3 — the group says the workflow, the card says what is particular.** Each group's summary says what its tools
  share (open bills come in for review and none is paid until a person adds it and it passes every check; won deals
  come in to plan and a person confirms every plan; finished work is paid once a person accepts it). A card then says
  only what differs: whether the tool is written back to, who allows that, and what is left out. No arrow diagrams: one
  short sentence reads faster and says the conditions an arrow would drop.
- **L4 — every sentence as the product behaves (checked 2026-10-16 against the guides and code).** Xero is the only
  accounting tool written back to, and only an entry a person approves. QuickBooks Online, Zoho Books and Zoho CRM say
  "Read-only." HubSpot's write-back is "once you allow it"; Pipedrive's is for payments on Arc mainnet only. A completed
  Asana task is paid only after a person accepts it against its criteria. Slack shows decisions, answers what is waiting
  and pauses the agent; nothing says it pays (Approve and pay is opt-in, Arc testnet only, never on mainnet). The
  Telegram bot never pays.
- **L5 — QuickBooks Online's status, said where it matters.** The hosted service still connects to QuickBooks sandbox
  companies only, until Intuit completes its assessment of the app (release notes beta.1 to beta.7). Its card carries
  "Sandbox companies for now", and its guide says so under "Before you start". Remove both once production companies
  connect.
- **L6 — one label for one kind of link.** Every tool links to its guide, which says what the tool does and how to
  connect it, so every card says "Setup guide". Varying the words ("See how it works", "View integration") for links
  that lead to the same kind of page would suggest different destinations. No "Connect": connecting needs a signed-in
  owner or admin in Settings, so the landing page offers none. The whole card is the link.
- **L7 — what it is built on, below and quieter.** "Under the hood": Arc (settles on; see the payments, arc.io), Circle
  (payments through; the code, circle.com) and the SDK on npm (SDK docs), in one ruled panel with small marks and the
  role labels in mono. The role labels stay here because they say each relationship. The SDK is a peer of Arc and
  Circle instead of an orphan row. Superseded the same day by `2026-10-16-landing-arc-circle-design.md`: Arc and Circle
  are now a larger pair, "Built on Arc, with Circle", with what the product does on each and links to the evidence,
  and the SDK is a line under them.
- **L8 — sizes.** Marks are 24 px beside a written name; the wordmarks and lockups are tuned per mark (Zoho's 26,
  Pipedrive's 22, Asana's 20) so they look the same size, each its owner's file unaltered. Card sentences are 14 px
  (12 px before), the trademark notice 12 px (11 before).
- **L9 — layout.** From 1024 px each group's heading sits in a 13.5 rem column beside its three cards; from 768 px the
  heading is above three cards; below 768 px a group's tools are rows of one bordered list, the guide's link beside the
  mark, so a phone does not scroll through nine boxes. The panel under the hood goes from three columns to three rows.
- **L10 — interaction.** Hover darkens a card's border and nudges its arrow (no nudge under reduced motion); keyboard
  focus is the site's one ring, which follows the card's corners. The section has one `Reveal`, on its heading.
- **L11 — trust.** "Built on" and "works with", never partners, trusted by, powered by or certified; the trademark
  notice is unchanged in its words.

## Not done

- No tabs or filters: twelve entries read faster laid out than behind a control.
- No integrations index page exists to link to; each card links to its own guide.
- The section is taller than the strip was (at 1440 px about 1,480 px instead of 650; at 390 px about 2,600 instead of
  1,250): the price of 14 px text, a sentence per group and one column on a phone.

## Tests

`tests/brand-marks.test.tsx` ("the landing page's integrations"): the groups and their order, the four headings and the
lists they name, three to a row and no other grid, twelve entries; every name, link and mark in order, wordmarks named
for screen readers; "Setup guide" on every card and no "Connect now"; the sentences that carry a condition (Xero's
approval, read-only, the sandbox status, HubSpot's allow, Pipedrive's mainnet, Asana's acceptance, Slack never says
pay, the Telegram bot never pays); no endorsement wording and the trademark notice.
`tests/landing-arc-circle-links.test.tsx`: Arc's and Circle's own sites open in a new tab with no opener, and the
evidence links stay.

Screenshots: `landing-integrations-shots/` at 1440 and 390 px, before and after.
