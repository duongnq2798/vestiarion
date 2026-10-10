# Workspace shell: navigation, header and status

Date: 2026-10-10. Status: decided (autonomy grant 2026-10-05). Source: a UI review of the workspace frame, relayed by the
partner the same day.

## Why

The workspace frame grew one page at a time. A review of it found:

- Eleven sections listed with the same weight, grouped as Overview, Operations and Controls. Approvals, the page most
  people open every day, sat ninth. Members and Settings sat under Controls.
- Content capped at 72rem and centred, so a 1920px screen left about 250px empty on each side of the Treasury page.
- Status said in three badges above every page, each ending in LIVE or SIMULATED: Payments, Yield and Screening. They
  did not say whether the workspace was in shadow mode, or that the platform switch had stopped payments.
- The Screening badge was wrong. `ProductShell` asked for the screening mode while it rendered, which is outside the
  workspace's scope, so it read the deployment's settings. A sandbox on a deployment with OpenSanctions said
  "OpenSanctions · Live", although a sandbox screens against the bundled list.
- No way to give the sidebar's width back to the content.
- "AP / AR" is an accountant's abbreviation. Most people who pay bills do not use it.

This change is presentation and wiring only. No payment rule, approval rule, limit, screening rule or signed record
changes.

## Decisions

**S1. Navigation groups.** The sidebar, the drawer and the command palette all read `NAV_GROUPS` in `nav.ts`, which
keeps one list:

| Group | Sections |
|---|---|
| (unlabelled) | Treasury, Approvals |
| Operations | Bills & receivables, Counterparties, Contractors |
| Controls | Compliance, Audit log |
| Analytics | Insights, Report |
| Workspace | Members, Settings |

- Treasury stays first, so `HOME_PATH` stays `/console`. Approvals moves next to it: it is where a person decides what
  the agent would not pay alone.
- No path changes, so bookmarks and the links in Slack, Telegram and email keep working.
- Cost if wrong: people who learned the old order look once.

**S2. "AP / AR" becomes "Bills & receivables".** The page is still `/invoices`. Every place that names the page (the
app, Slack, Telegram and email messages, the guides, the screenshots) says the new name. "Report" stays singular: it is
one page.

**S3. A sidebar that collapses to an icon rail.** From `lg` (1024px) up:

- Expanded: 14.5rem (232px). Collapsed: 4rem (64px), icons only. Each icon keeps its name for screen readers, and a
  tooltip on hover or keyboard focus. The current section keeps its tint in both states.
- Collapsed, the workspace switcher is its avatar, search is an icon, and the account menu is an avatar. Their menus
  open to the right.
- The toggle is the first control in the page header. `[` toggles it from anywhere except a text field, and the
  command palette offers it too.
- The choice is kept in a first-party cookie, `vx_sidebar` (a year, `Path=/`, `SameSite=Lax`), written by the browser
  when someone toggles. The workspace layout reads it, so the server draws the right width and nothing jumps on load.
  The privacy page lists it.
- Below `lg` the drawer is unchanged and always expanded.

**S4. A header on every workspace page.** `ProductShell` draws it, because the statuses it shows are read inside the
workspace's scope (S5); the layout reads no organization rows, and keeps it that way.

- From `lg`: a sticky 56px bar. On the left, the sidebar toggle and where you are: the workspace, then the section. On
  the right, when the agent last ran (shortened with an ellipsis where room is short, never hidden), and the status
  chips (S5).
- Below `lg` the phone bar (menu, section, search) stays on top, and the chips and the last run sit in a row under it.
- The header is not a heading: each page keeps its own `<h1>` in `PageHead`.
- The banners (Arc mainnet, payments switched off, agent paused) move from above the page to below the header, inside
  the page's frame. Their words do not change.
- The loading and error states draw the same header, from what the layout knows, so a page lands without a jump.

**S5. Status: three chips, and a panel that explains them.** Each chip answers one question, in words, with a dot or an
icon beside it, never colour alone.

1. **Network**: the workspace's network by name, `networkProfile(network).label`. Arc mainnet is drawn in the brand
   blue with a solid dot; Arc testnet is neutral with a hollow dot.
2. **Payments**, first match wins:
   - Payments off: the platform switch is off (from the layout).
   - Payments held: nothing can pay now (`paymentsHeld()`: Arc mainnet switched off or not live yet, or the
     workspace's wallet credentials cannot be read).
   - Shadow mode: shadow mode is on. The agent decides each bill and nothing is paid until a person agrees.
   - Payments simulated: the chain mode is simulate.
   - Payments live: the chain mode is live. On Arc testnet that is USDC on the test network; on Arc mainnet real USDC.
3. **Agent**: Agent paused (with since, by and why), or Agent on. While payments are off or held it says Agent
   stopped: every cycle refuses first. A pause does not stop a person paying from Approvals, and the panel says so.

A fact that could not be read (the payments switch, the pause, shadow mode) is shown as not known, in words, never as its
healthy value: the payment gates refuse on a switch they cannot read, and the agent pays nothing on a shadow mode it
cannot read.

Pressing any chip opens "Workspace status", a panel with one row per fact: network, payments, shadow mode, agent,
reserve (USYC, where the network has it), screening (its source, read inside the workspace's scope) and the clock (wall
clock, or day N of the demo clock).

- Payments live/simulated/held comes from `shellModes()`, the same call the status API uses. Shadow mode comes from
  `readShadowMode`; a failed read shows "Could not be read", never off. Screening is computed in the page's scope,
  which fixes the wrong badge described above.
- Each page passes these as `status={await shellStatus()}` to `ProductShell`, beside the existing `chainModes`.
- The badges strip above each page goes. The landing page keeps its `ProvenanceBar`.

**S6. Wider content.** One frame for the page, the loading state, the error state and the banners:
`max-w-[90rem]` (1440px) with the same padding. At 1920px the Treasury page gains about 290px. The Treasury figures
and columns follow the page's own width (container queries), not the window's: from 64rem of content the last figure
sits over a 22rem aside, and from 80rem of content (about 1600px with the sidebar open, 1430px folded) both are 24rem.

**S7. Page head.** The title is 24px at every width, the gap below it smaller. Pages keep their subtitles and actions.

**S8. Treasury.**

- KPI tiles are equal height, figures in tabular numbers.
- Shadow mode leads with the agreement rate as a figure, then the counts, then where to give a verdict. In a workspace
  whose payments are simulated, it says agreeing simulates the payment instead of naming the network.
- A decision waiting for a person's verdict says "Waiting for your verdict", not "Held for you", so a shadow decision
  is not read as a problem.
- Stopped shows three and links to Bills & receivables, which lists them all, when there are more. Scheduled payments
  links there too.
- Every anchor lands below the header: `scroll-padding-top` on the page replaces per-element guesses.

**S9. Command palette.** Sections are grouped as in the sidebar. A few shortcuts to places that already exist: add a
counterparty, the agent's spending limit, shadow mode, go live. On a wide screen it can collapse or expand the sidebar.
Nothing in it moves money.

## Not changed

Payment execution, approvals (two-person and sole approver), spending limits on code and on Arc, the stop switch,
screening, matching, the ledger, idempotency, wallets and passkeys, roles. Routes, query parameters and fragments.

## Testing

- Pure functions: the status chips' truth table, the cookie parser, the nav groups.
- Rendered markup: the header in each status, the collapsed rail's accessible names.
- Source pins updated where the change is deliberate (nav groups, the ProductShell props, Shell's screening import).
- Browser: 375, 390, 768, 1024, 1280, 1440 and 1920px, expanded and collapsed, under reduced motion and classic
  scrollbars.
