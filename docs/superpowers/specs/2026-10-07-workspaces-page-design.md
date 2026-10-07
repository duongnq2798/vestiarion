# The workspaces page: welcome back to the workspace in use

Date: 2026-10-07. Status: shipped with this branch.

## 1. Why

`/onboarding` is where everyone lands after signing in. It read "Choose a workspace" over an unordered list, then a
create form as tall as the list with the page's strongest button: someone with five workspaces, who almost always wants
the one they were just in, was offered a sixth as loudly. The column was 448 px on a desktop, and the network choice
named chains before saying what each workspace is for, asking about a Circle account before one is needed.

## 2. Rulings

- **W1 — two states.** Someone with no workspace reads "Welcome to Vestiarion" and the form to create their first, as
  before. Someone with one is still sent straight in, unless the link asked to list (`?new`) or create (`?create`).
  Someone with several reads "Welcome back" and "Choose a workspace to continue."
- **W2 — the workspace in use first.** Workspaces are ordered by `orgs.last_active_at`, which `touchOrgActivity` already
  refreshes when a member opens one, at most hourly; no schema change. The first carries "Most recent", and each says
  when it was last in use in words that claim no more than the hourly refresh can tell ("Active in the last hour",
  "Active 5 hours ago", "Active yesterday", "Last active Aug 28, 2026"). It is the workspace's last use by any member,
  not the reader's own, so it says "Active", never "You opened". Past three workspaces, the three most recent lead under
  "Recent" and the rest follow under "Other workspaces".
- **W3 — creating another is secondary.** "Create a new workspace" is a button under the list that opens the form in
  place. The switcher's and the command palette's "Create workspace" link to `?create#create-workspace`, which opens it.
- **W4 — what it is for, then where it runs.** With Arc mainnet offered: "Test workspace" (Recommended), Arc testnet,
  simulated money; "Production workspace" (Real funds), Arc mainnet, "Real USDC: nothing moves until an owner finishes
  setup and takes it live." The Circle account is asked for when an owner takes it live, not here. Every form ends with
  "Creating a workspace moves no money", true of both: a sandbox simulates, and Arc mainnet waits for go-live.
- **W5 — a wider column.** The page's column, and the header over it, grow from 448 px to 544 px.

## 3. Tests

`tests/workspaces-page.test.tsx` renders the page in each state: the first workspace; one list with the most recent
first and marked; "Recent" and "Other workspaces" past three; the form closed, and open under `?create`; the
single-workspace redirect. It also holds the recency wording and order. `tests/membership-network.test.ts` reads
`last_active_at`, and `tests/create-workspace-form.test.tsx` the new choices and reassurance.
