# Every Workspace Names Its Network (Phase 2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every message and page that belongs to a workspace names its network, panels for features a network lacks are not drawn, the status API says `unavailable` whenever nothing pays, and going live opens on Arc mainnet.

**Architecture:** One name per network, the profile's `label`, read from wherever each surface already stands (C1). Substantive differences branch on profile fields (`faucet`, `hostedWallets`, `usyc`, `escrow`, `gateway`). A copy ratchet test keeps testnet literals in an allowlist of files with counts and reasons.

**Tech Stack:** Next.js (App Router), TypeScript, Vitest, React Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-06-mainnet-copy-design.md`.

**Plan level (autonomy grant):**
- Interfaces and the tests for new behaviour are locked here.
- Copy moves are exact transformation rules over the listed files, checked by each surface's mainnet test and by Task 8's ratchet.

## Global Constraints

- **Arc testnet reads letter for letter as before.** The only exceptions are C9's four lines: the explorer label "View the transaction", the accounts list's chain label, `/open`'s testnet blurb, and onboarding's wallet line.
- **An existing testnet expectation changes only for those four.** Any other testnet test that changes is a finding.
- **The network's name is `networkProfile(id).label`** (or `profile.label`), never a literal, in every class-A surface.
- **No migration.** No change to `MAINNET_ENABLED` handling, the allowlist, the typed word, or the payments switch.
- **Product copy:** say "Arc testnet" or "Arc mainnet" plainly. Never "no real money", "fictional" or "simulated money".
- **Commit messages** describe the change plainly.
- **Docs move with the change in the same task:** guides, changelog, README, ARCHITECTURE, OpenAPI, SDK.
- **Each task ends with `npm run verify` green** before its ledger line. The last task also runs `npx next build`.

## Review Focus

1. **A mainnet record rendered outside its workspace's scope.** This covers the GitHub webhook reply, `/pay`, `/payee` and `/receipt`. It must name the record's own network (its chain or `orgs.network`). It must never fall back to a default or to `workspaceNetwork()`, which throws outside a scope. Each such surface's mainnet test builds the record with an Arc mainnet chain and no scope.
2. **Old ledger entries on a mainnet workspace.** Render-time reasoning (decision trail, receivable reasoning) names the viewed workspace's network. Stored summaries are not rewritten. Task 5's trail test renders an entry with no stored network under an Arc mainnet option.
3. **A testnet sandbox workspace's status.** It must stay `simulate`/`simulate`, because the network hold is null on Arc testnet. Task 7's test pins it beside the mainnet cases.
4. **A panel hidden on Arc mainnet that guards a state Arc mainnet can reach.** USYC, escrow and Gateway have no mainnet state: their writes refuse by `FeatureOffError`. Task 4's tests render each page for Arc mainnet and find no panel, and render it for Arc testnet and find it.
5. **A builder whose network argument is optional, defaulting to Arc testnet.** A production caller that forgets it would name testnet on mainnet. Builder inputs take `network` as a required field so TypeScript finds every caller. The compact footer's default is the only exception (C6).

---

### Task 1: The profile names its faucet

**Files:**
- Modify: `src/lib/network.ts` (`NetworkProfile` gains `faucet`; ARC_TESTNET `"https://faucet.circle.com"`, ARC_MAINNET `null`)
- Modify: `src/components/GoLivePanel.tsx` (its `FAUCET` constant reads `ARC_TESTNET.faucet`)
- Test: `tests/network.test.ts` (whole-profile expectations gain the field)

**Interfaces:**
- Produces: `NetworkProfile.faucet: string | null`. "Where people get test tokens: Circle's faucet on Arc testnet, none on Arc mainnet (phase 2c C2)."

- [ ] Step 1: add `faucet` to both whole-profile expectations in `tests/network.test.ts`. Run `npx vitest run tests/network.test.ts`. Expected: FAIL, the profiles lack `faucet`.
- [ ] Step 2: add the field and its doc comment, and set both values. In GoLivePanel, set `const FAUCET = ARC_TESTNET.faucet ?? ""` (the funding hint already branches on mainnet).
- [ ] Step 3: run the test. Expected: PASS. Then `npm run verify`, and commit "Name each network's faucet in its profile".

### Task 2: A client and a payee read their payment's network

**Files:**
- Modify: `src/lib/email/payee-link.ts`, `src/lib/email/payment-notice.ts`, `src/lib/email/receivable-reminder.ts`. Each input gains `network: Network`, and each "Arc testnet" becomes `${label}` with `const { label } = networkProfile(input.network)`.
- Modify the callers:
  - `src/lib/pay-freelancer.ts:175`: `workspaceNetwork().id`.
  - `src/lib/payment-notices.ts:145`: the intent's `networkOf(intent.network)`, already read for the transaction link.
  - `src/lib/agent/collections.ts:224`: `workspaceNetwork().id`.
- Modify: `src/app/pay/[token]/page.tsx`. Lines 77 and 89 use `chainById(preview.chain).label`, the link's home chain, whose label is the network's.
- Modify: `src/app/pay/[token]/actions.ts`. `received` names the network. Rule: `checkPayLink` returns `{ outcome, network: Network | null }` from the `previewPayLink` it already reads, and the action builds "Received, thank you. The payment is recorded on ${label}." from it. With no preview, it says "Received, thank you. The payment is recorded."
- Modify: `src/components/payee/PayeeJourney.tsx`.
  - Lines 200 and 201: "A payment on ${home} is final…" and "It was sent from ${home}…", where `home = networkProfile(networkOfChain(status.chain)).label`.
  - Line 191: "View on Arcscan" becomes "View the transaction" (C7).
- Modify: `src/components/receipt/ReceiptView.tsx:34`. The direct route reads `A transfer on ${networkProfile(networkOfChain(facts.chain)).label}`. Lines 33 and 97, the CCTP route, stay: CCTP is Arc testnet only.
- Modify: `src/components/vx/SiteChrome.tsx`. The compact footer takes `networkLabel?: string`, defaulting to "Arc testnet" (C6). `/pay`, `/payee` and `/receipt` pass their chain's network label.
- Tests:
  - `tests/payee-emails.test.ts`, `tests/payment-notices.test.ts`, `tests/collections-email.test.ts`: the existing calls pass `network: "arc-testnet"`, and one new mainnet case each.
  - The pay page, payee journey, receipt and site-footer tests: one mainnet case each.

**Interfaces:**
- Consumes: `networkProfile`, `networkOf`, `networkOfChain`, `chainById` (`src/lib/network.ts`, `src/lib/payee-chains.ts`).
- Produces:
  - `payeeLinkEmail({..., network: Network})`, `paymentNoticeEmail({..., network: Network})`, `receivableReminderEmail({..., network: Network})`;
  - `checkPayLink(token, ...)` returns `{ outcome: PayLinkCheck; network: Network | null }` (the existing outcome is kept, with the network added);
  - `SiteFooter` / compact footer prop `networkLabel?: string`.

- [ ] Step 1: write the mainnet tests first. Each builds its input with `network: "arc-mainnet"` (or an `"ARC"` chain for a page) and asserts:

```ts
expect(text).toContain("Arc mainnet");
expect(text).not.toContain("Arc testnet");
```

  For each email this covers both the text part and the HTML part. For the reminder it also covers the button label ("Pay on Arc mainnet").
- [ ] Step 2: run them. Expected: FAIL, with "Arc testnet" found (or a type error on the new field).
- [ ] Step 3: apply the rules above. Pass `network: "arc-testnet"` in the existing testnet calls (TypeScript lists them).
- [ ] Step 4: run the touched test files. Expected: PASS, with no testnet expectation changed except "View on Arcscan" becoming "View the transaction".
- [ ] Step 5: `npm run verify`, then commit "Tell a client and a payee the network their payment is on".

### Task 3: A member approving or watching a payment reads its network

**Files:**
- Modify: `src/lib/agent-activity.ts`. `ActivityItem` gains `network: Network`, from `refs.network`. Line 242 reads "…; ${label} is confirming it."
- Modify: `src/lib/slack/blocks.ts`.
  - Line 76: the button label is `${networkProfile(item.network).label} transaction`.
  - Lines 171 and 175: `outcomeLine(..., network)` uses its existing `network` argument's label.
- Modify: `src/lib/slack/notify.ts:81`. The Approve and pay confirmation uses `workspaceNetwork().label`, which is already read at line 65 as `.id`.
- Modify: `src/lib/telegram/messages.ts:71`. The link label is `${networkProfile(item.network).label} transaction`.
- Modify: `src/lib/github/bounties.ts`.
  - `BountyReply` gains `network: Network`.
  - `handlePullRequestComment` reads `orgs.network` in the select it already makes for the name.
  - Lines 123 and 150 use the label.
- Modify: `src/components/ApprovalCard.tsx:244`. It takes a `network: Network` prop, which the approvals page passes from `workspaceNetwork().id`.
- Modify: `src/components/AgentActivity.tsx:149`. "View on Arcscan" becomes "View the transaction" (C7).
- Tests: `tests/agent-activity.test.ts`, `tests/slack-blocks.test.ts`, `tests/slack-notify.test.ts`, `tests/telegram-messages.test.ts`, `tests/github-bounties.test.ts`, and the approval card test, each with one Arc mainnet case. The existing items gain `network: "arc-testnet"`.

**Interfaces:**
- Produces: `ActivityItem.network: Network`, `BountyReply.network: Network`, and `ApprovalCard` prop `network: Network`.

- [ ] Step 1: write the mainnet cases with the assertion shape from Task 2, Step 1. For GitHub, the fake `orgs` row has `network: "arc-mainnet"` and the reply has no scope.
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: apply the rules, and update the existing fixtures with the new field.
- [ ] Step 4: run. Expected: PASS. Then `npm run verify`, and commit "Name the network in Slack, Telegram, GitHub and the approval card".

### Task 4: Workspace pages name their network, and draw only what it has

**Files:**
- Modify: `src/components/vx/Shell.tsx`.
  - `ProductShell` takes `network: Network`.
  - The Payments leg's detail and the footer badge use `networkProfile(network).label`.
  - The Yield leg is drawn only where `networkProfile(network).usyc`.
- Modify the 10 pages that mount `ProductShell` (`src/app/o/[slug]/{approvals,audit,compliance,console,contractors,counterparties,insights,invoices,members,settings}/page.tsx`): each passes `access.membership.network`, or the `network` it already reads.
- Modify: `src/lib/getting-started.ts`.
  - `GettingStartedInput` gains `network: Network`, which the console passes.
  - The wallet step offers "a hosted wallet in one click" only where `profile.hostedWallets`.
  - The funding step uses Circle's faucet only where `profile.faucet`. Otherwise it reads "Send USDC on ${label} to the operating wallet, keeping ${profile.gasReserveUsdc} USDC aside for its gas", with the gas part only when the reserve is above 0.
  - Lines 112 and 127 use the label.
- Modify:
  - `src/components/PayLinkControl.tsx:91`, `src/components/intake/CounterpartyNoticeEmailEdit.tsx:46` and `src/components/GitHubPanel.tsx:74`: each takes `network: Network` from its page and uses the label.
  - `src/components/vx/Treasury.tsx:127`: `chainById(account.chain)?.label ?? account.chain` (C8).
- Modify: `src/app/o/[slug]/settings/page.tsx`. The USYC reserve panel renders only where `workspaceNetwork().usyc`.
- Modify: `src/app/o/[slug]/contractors/page.tsx`. The escrow disclosure renders only where `workspaceNetwork().escrow`.
- Modify: `src/app/o/[slug]/console/page.tsx`. The Gateway panel renders only where `workspaceNetwork().gateway`.
- Modify: `src/app/open/page.tsx:30`. "Payments on Arc testnet, where every workspace runs today." becomes "Payments on Arc testnet." (C5).
- Modify: `src/app/onboarding/page.tsx:129`. "An owner adds an Arc testnet wallet from Settings" becomes "An owner adds a wallet from Settings" (C5).
- Tests:
  - shell, getting-started (pure and UI), pay-link control, counterparty notice email, GitHub panel and treasury tests;
  - the settings, contractors and console page tests (panels absent on Arc mainnet, present on Arc testnet);
  - the open-page and onboarding expectations for the two C5 lines.

**Interfaces:**
- Produces: `ProductShell` prop `network: Network`, `GettingStartedInput.network: Network`, and the `network: Network` props above.

- [ ] Step 1: write the mainnet cases.
  - The shell for `"arc-mainnet"` shows "Arc mainnet" twice and no "Yield" leg.
  - `gettingStarted({..., network: "arc-mainnet"})` has no step text containing "faucet", "hosted" or "Arc testnet", and its funding step says "Arc mainnet" and "0.1 USDC".
  - The three pages for Arc mainnet have no USYC, escrow or Gateway panel.
  - The C8 and C5 lines read as ruled.
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: apply the rules.
- [ ] Step 4: run. Expected: PASS. Then `npm run verify`, and commit "Name the network on every workspace page, and draw only the features it has".

### Task 5: Text the agent stores or gives a model names its network

**Files:**
- Modify: `src/lib/agent/proposals.ts:174` and `src/lib/telegram/route-text.ts:16`. Each system prompt becomes a function of the label, called with `workspaceNetwork().label` where the prompt is sent.
- Modify: `src/lib/agent/receipts.ts:189,204`. These use `provider.network.label`.
- Modify: `src/lib/platform/pay-links.ts:122`. This uses `workspaceNetwork().label`.
- Modify: `src/components/vx/map.ts:183,192`. `receivableDecision` takes the `options.network` that `decideInvoice` already has.
- Modify: `src/lib/decision-trail.ts:177,184,199`. `trailStep(entry, network?)` and `invoiceTrail(entries, id, network?)` take an optional network that defaults to Arc testnet, for the tests that call them bare. Both callers in `map.ts` pass `options.network`.
- Modify: `src/lib/agent/guardrails.ts:379` and `src/lib/circle/liveProvider.ts:277`. The faucet clause only where `profile.faucet`:
  - guardrails reads `workspaceNetwork()` (cycle scope);
  - liveProvider reads `this.network`.

  Otherwise: "fund EURC first" / "Fund it with EURC first."
- Modify: `src/lib/api/schemas.ts:150`. The `txHash` description says "on the workspace's network". Regenerate `sdk/src/types.ts` with `npm run sdk:types`; the version bump is Task 7's.
- Tests: proposals, route-text, receipts (agent), pay-links, map/vx-display, decision-trail, guardrails, and the circle-live-provider EURC case, each with an Arc mainnet case. Plus the openapi and sdk-types tests.

- [ ] Step 1: write the mainnet cases. Each finds "Arc mainnet" and no "Arc testnet"; the EURC ones find no "faucet". The trail case renders a stored entry under `network: "arc-mainnet"`.
- [ ] Step 2: run them. Expected: FAIL.
- [ ] Step 3: apply the rules.
- [ ] Step 4: run. Expected: PASS. Then `npm run verify`, and commit "Name the network in the agent's prompts, ledger text and reasoning".

### Task 6: Settings on Arc mainnet say what stays (C11)

**Files:**
- Modify: `src/components/TwoApprovalsPanel.tsx`.
  - New prop `keepsFigure: boolean`.
  - When true, the Turn off form is not rendered, and the line "A workspace on Arc mainnet keeps two approvals above a figure. Raise it to let one person pay more." shows under the figure.
- Modify: `src/app/o/[slug]/settings/page.tsx`. It passes `keepsFigure={workspaceNetwork().id === "arc-mainnet"}`.
- Modify: `src/components/AgentBudgetPanel.tsx`. The `BudgetDialog` description ends "A workspace on Arc mainnet keeps a daily or 7-day limit." in place of "Leave a figure blank for no limit." when `network === "arc-mainnet"`. The panel already has `network`.
- Modify: `content/docs/guides/first-payment.mdx`. The two-approvals section and the spending-limit section each say what Arc mainnet keeps.
- Tests: `tests/two-approvals-panel.test.tsx` and `tests/agent-budget-panel.test.tsx` (or the existing files that render them), plus `tests/docs-guides.test.ts` if it pins the guide.

```tsx
it("offers no Turn off on Arc mainnet, and says the figure stays (mainnet copy C11)", () => {
  render(<TwoApprovalsPanel orgSlug="acme" status={{ above: 100, approvers: 1 }} canChange keepsFigure />);
  expect(screen.queryByRole("button", { name: "Turn off" })).toBeNull();
  expect(screen.getByText(/keeps two approvals above a figure/)).toBeTruthy();
});
```

- [ ] Step 1: write the test above, and the budget dialog's mainnet sentence test. Run them. Expected: FAIL.
- [ ] Step 2: implement, and edit the guide.
- [ ] Step 3: run. Expected: PASS. Then `npm run verify`, and commit "Say on Arc mainnet that two approvals and the agent's limit stay".

### Task 7: The status API answers unavailable whenever nothing pays (C12)

**Files:**
- Modify: `src/app/api/v1/status/route.ts`.
  - `const noPayments = hasNoProvider(config) || Boolean(config.chain.networkHold);`
  - `payments: noPayments ? "unavailable" : modes.mode`.
  - `yield: noPayments || !networkProfile(networkOf(config.network)).usyc ? "unavailable" : modes.earnMode`.
  - The docstring is updated to match.
- Modify the descriptions: `src/lib/api/openapi.ts` (the operation), `src/lib/api/schemas.ts` (`StatusSchema` provenance), and `content/docs/api/get-status.mdx`.
  - "`unavailable` means nothing can pay in this workspace now: its Circle credentials are stored but cannot be read, or it is on Arc mainnet and cannot pay yet (no Circle account connected, not live yet, or Arc mainnet switched off on this deployment). Yield is also `unavailable` on a network with no yield reserve, such as Arc mainnet."
  - The reference page's bullet list gains "It is on Arc mainnet and not live yet." and the yield sentence.
- Modify: `content/docs/changelog.mdx`. A new dated entry (2026-10-06, newest first) covers the status change and the `txHash` description.
- Modify the SDK, which goes to 0.3.2:
  - `sdk/package.json` and `sdk/src/version.ts` read 0.3.2;
  - `npm run sdk:types` regenerates the types, and `npm run sdk:pack` packs the release;
  - `content/docs/get-started/sdk.mdx` (install URL and version sentence) and `sdk/README.md` point at 0.3.2.
- Tests:
  - `tests/api-key-scope.test.ts`: the cases below.
  - `tests/openapi.test.ts`: the "names every reason" test gains `/not live yet/` and `/no yield reserve/`.

```ts
it("reports unavailable for a connected mainnet workspace that is held, and yield unavailable without USYC (mainnet copy C12)", async () => {
  // As the switched-off test builds it: own Circle account sealed under the current key, wallet_host "own".
  expect(await provenance({ mainnetEnabled: true, mode: "sandbox" })).toEqual({ payments: "unavailable", yield: "unavailable", screening: "simulate" });
  expect(await provenance({ mainnetEnabled: true, mode: "live" })).toEqual({ payments: "live", yield: "unavailable", screening: "simulate" });
});
```

  The existing "switched off" test keeps its first expectation. Its second, `(await provenance(true)).payments === "live"`, holds for a live workspace. The testnet cases are unchanged; a testnet sandbox workspace still answers `simulate`/`simulate`.

- [ ] Step 1: write the tests. Run them. Expected: FAIL (held answers `live`, yield answers `simulate`).
- [ ] Step 2: implement, then edit the descriptions, the reference page, the changelog and the SDK.
- [ ] Step 3: run `npx vitest run tests/api-key-scope.test.ts tests/openapi.test.ts tests/sdk-*.test.ts tests/docs-*.test.ts`. Expected: PASS. Then `npm run verify`, and commit "Answer unavailable while a mainnet workspace is held, and for yield without a reserve; SDK 0.3.2".

### Task 8: A copy ratchet keeps testnet words where they are true (C10)

**Files:**
- Create: `tests/network-copy-ratchet.test.ts`. It reuses network-ratchet's `walk` and `code`, copied, since tests share no module.
- Modify: `ARCHITECTURE.md`. The network section gains one paragraph: copy names the workspace's network from its profile, and the ratchet lists where testnet words stay and why.

```ts
const COPY = /Arc testnet|testnet USDC|faucet/gi;
const PROFILE = "src/lib/network.ts";
/** Files whose testnet words are true wherever they show (phase 2c C5, C10): each with its count and why. */
const ALLOWED: Record<string, number> = {
  // Filled from the run after Tasks 1-7: every remaining file, with its count, under a comment saying why
  // (platform page | demo data | feature only Arc testnet has | branch that runs only on Arc testnet).
};

describe("testnet words in copy (mainnet copy C10)", () => {
  it("appear only in files where they are true wherever they show, no more often", () => {
    const counts: Record<string, number> = {};
    for (const file of walk(path.join(ROOT, "src")).filter((name) => /\.(ts|tsx)$/.test(name))) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      if (rel === PROFILE) continue;
      const found = code(readFileSync(file, "utf8")).match(COPY)?.length ?? 0;
      if (found > 0) counts[rel] = found;
    }
    expect(counts, "a workspace's copy names its network from the profile; a count that went down is written down here").toEqual(ALLOWED);
  });

  it("counts copy in code, and not in a comment", () => {
    expect(code('// on Arc testnet\nconst a = "on Arc testnet";').match(COPY)).toHaveLength(1);
  });
});
```

- [ ] Step 1: write the test with an empty `ALLOWED`, run it, and read the list it prints.
- [ ] Step 2: for each file in that list, decide:
  - **class A missed by Tasks 2-6:** fix it, with a mainnet test, in this task. This is a finding, so write a ledger ruling.
  - **class B or a testnet-only branch:** add it to `ALLOWED` with its count and a reason comment.
- [ ] Step 3: run the test. Expected: PASS. Then make one probe edit, adding "Arc testnet" to a non-listed file's string. Expected: FAIL. Revert the probe.
- [ ] Step 4: `npm run verify`, then commit "Keep testnet words to the files where they are true".

### Task 9: Going live opens on Arc mainnet (C13)

**Files:**
- Modify: `src/lib/network.ts`. ARC_MAINNET `goLiveOpen: true`, and the field's comment says when a network opens.
- Modify: `src/lib/platform/go-live.ts`. The comment at the check says the check stays for any future network.
- Modify:
  - `tests/network.test.ts`: the mainnet profile's `goLiveOpen` is true.
  - `tests/go-live-lib.test.ts`: the 2a I3 test, "asks for the word typed, then refuses going live by name…", becomes the C13 tests below.
- Modify the docs:
  - `content/docs/guides/go-live.mdx`: its Arc mainnet section says going live is open on a deployment with Arc mainnet switched on, and lists what it needs.
  - `README.md:537` and `ARCHITECTURE.md:344` drop "stays closed until…".
  - The 2b spec's L9 gains a pointer to this spec.
  - `content/docs/changelog.mdx`: a line under Task 7's entry.

```ts
it("takes a connected mainnet workspace live for an allowed person who typed the word (mainnet copy C13)", async () => {
  // Arrange as the 2a mainnet go-live tests do: network arc-mainnet, mainnetEnabled true, allowlisted actorEmail,
  // own Circle account, operating wallet with circle_wallet_id, a client whose wallets prove the same entity.
  await goLive({ orgId, actorId, actorEmail: "owner@example.com", confirmation: "mainnet", client });
  expect(orgMode()).toBe("live");
});

it("still refuses while the deployment has Arc mainnet switched off (mainnet copy C13)", async () => {
  // Same workspace, mainnetEnabled false.
  await expect(goLive({ orgId, actorId, actorEmail: "owner@example.com", confirmation: "mainnet", client })).rejects.toThrow(MAINNET_OFF);
});
```

- [ ] Step 1: write the tests (the fixtures follow the existing mainnet go-live tests in the same file). Run them. Expected: the first FAILS with "Going live does not run on Arc mainnet yet", and the second passes.
- [ ] Step 2: set `goLiveOpen: true`, and edit the comments and docs.
- [ ] Step 3: run `npx vitest run tests/go-live-lib.test.ts tests/network.test.ts tests/docs-*.test.ts`. Expected: PASS. Then `npm run verify` and `npx next build`, and commit "Open going live on Arc mainnet".
