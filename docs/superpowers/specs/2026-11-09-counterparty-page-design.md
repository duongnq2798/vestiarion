# One place for a contractor's links: the counterparty page

Date: 2026-11-09 · Status: PR A (C1 to C7) built, PR B (C8) not built · Branch: `feat/counterparty-page` (PR A), `feat/counterparty-links-chat` (PR B) · No migration

## Why

Today, to answer "where are we with this contractor?", a member has to visit five places. The address, the limit and the payee link are in a row on Counterparties. The milestones are on Contractors, the bills and receipts on Bills & receivables, and the changes in the Audit log. The evidence is on one evidence page per payment. Every "fix it" link in the product (Edit limit, Confirm address, Review screening, Add billing email) opens the long Counterparties list at a hash. The row also falls short in three ways:

- The address is cut short, with no explorer link and no safe way to copy it.
- A payee link shows only "sent · expires". Nobody can see whether an earlier link was used, replaced, revoked or left to expire.
- A receipt's state can only be found on Bills, and only by a writer.

This spec adds one page per counterparty. It shows everything Vestiarion holds about a counterparty, using the readers and controls that already exist. It makes no payment and creates no new kind of record. It also points every existing deep link at the exact part of that page.

## Words used here

- **Counterparty page**: `/o/[slug]/counterparties/[id]`, one per counterparty (vendor, contractor or client).
- **Payee**: a vendor or a contractor, someone the workspace pays. **Client**: a counterparty who pays the workspace.
- **Payee link**: the one-time `vxp_` link a payee opens to enter their own address (and, since 0133, to send their invoice). Only its SHA-256 is kept.
- **Receipt link**: the `vxr_` link a writer shares for a paid bill. It is shown once.
- **Section**: one anchored part of the page, named in `COUNTERPARTY_SECTIONS`.
- **Part**: one best-effort read behind a section. A part that fails says "Not read", never 0 or "none".

Code comments and test names cite the ids, for example `// CL5: copy only an address someone can trust` and `it("CL2: another workspace's counterparty is a 404, like one that does not exist")`.

## The rules

- **CL1 One page per counterparty, in a fixed order.**
  - Route: `src/app/o/[slug]/counterparties/[id]/page.tsx`. It opens for every role and for every counterparty role.
  - Sections in order, with their ids:
    - the header (title, sub text, tiles);
    - `profile`, which holds the lines `screening`, `limit`, `billing-email` and `purchase-orders`;
    - `address`;
    - `payee-link` (payees only);
    - `milestones` (payees only);
    - `bills`;
    - `payments`;
    - `documents` (payees only);
    - `history`.
  - A section that applies but has nothing in it says so in one line. A section that does not apply to this counterparty's role is not rendered.
  - The Counterparties list stays as it is. Each opened row gains an "Open their page" link at the top. The row keeps its `counterparty-<id>` Disclosure id, so old bookmarks still open the row.
- **CL2 Isolation.**
  - `counterpartyIdOf(param)` lowercases the param and checks it against the UUID pattern. A param that fails is `notFound()` before any read.
  - `readCounterparty(id)` reads through `db()`, which applies RLS and the automatic `org_id` filter. A row in another workspace comes back null, so the page is `notFound()`, the same as for an id that does not exist. The 404 does not show which of the two it was.
  - A read that throws renders the shell with the held callout "This counterparty could not be read just now. Reload the page in a moment." (the Projects page pattern). It is never shown as a 404.
  - Every later read uses `counterparty.id` from that row, never the URL param.
  - `payee_links` is a platform table. Every read of it filters `.eq("org_id", access.membership.orgId)` and `.eq("counterparty_id", counterparty.id)`.
- **CL3 Grants.**
  - The pure `pageGrants(role, { cosigns, live, bankPayouts })` in `src/lib/counterparties/page-grants.ts` returns every grant the page uses.
  - The page makes one `cosignsNow(role)` call. It makes no `viewerCan` round trips.
  - Grants: `write = can(role, "records.write")`; `decide = can(role, "approval.decide")`; `confirmAddress = decide || cosigns`; `reconcile = can(role, "payables.reconcile")`; `manageBank` as on the list (BlindPay settings, `integrations.manage`); `seeLinks = write`; `shareReceipts = write && live`.
  - Data a role may not see is not read, not just hidden. A non-writer's page makes no `payee_links` read at all.
  - History is shown to every member, because the Audit log already is.
- **CL4 Secrets stay shown once.**
  - Every read names its columns. No read selects `token_hash`, a receipt token, ledger `detail`, or an email outside the billing email the list already shows.
  - A payee link URL or receipt URL appears only in the result of the action that made it, inside the dialogs that exist today: `CreatedPayeeLink` and the receipt control.
  - The conditions that mount those controls do not depend on state their own action changes. Write access and the row being shown are enough. A revalidation therefore cannot unmount a URL that was just shown (see the "Revalidate unmounts action results" lesson).
  - Server logs name the part that failed and the error name only, never the counterparty's name or address.
- **CL5 The payment address.**
  - The pure `addressFacts(counterparty, { lookalike, earlierLookalike, frozen })` gives the state: `none`, `set_when_added`, `confirmed`, `unconfirmed` or `frozen`.
  - The address is shown in full and wraps: `CounterpartyAddress` gets `full`. It is never shortened with `Hash`, because the first-6/last-4 short form is exactly what a lookalike copies.
  - The explorer link comes from the new `addressOnChainUrl(chain, address)` in `src/lib/payee-chains.ts`. It returns a link only when the address matches `^0x[0-9a-fA-F]{40}$` and the chain's `explorerTx` ends in `/tx/`, which it swaps for `/address/`. The link opens with `target="_blank" rel="noreferrer"`.
  - When the chain throws `ChainNotOnNetworkError`, the page shows "Not a chain this workspace pays on, so there is no explorer link."
  - "Copy address" (`CopyButton`) shows only when all of these hold: the state is `set_when_added` or `confirmed`, the counterparty is not frozen, and there is no lookalike or `earlierLookalike`. Otherwise one line says why (see UI words).
  - Confirm, edit and unfreeze are the existing controls with the list's grants. The payee lock is read for every role (Contractors already does) but is passed to the confirm form only when `confirmAddress`.
- **CL6 The payee link.**
  - This section is for payees, and only a writer gets it. Every other role sees one line: "An owner or admin sends and stops payee links."
  - The control is `PayeeLinkControl` with the list's props, including `offers={{ invoice: true, chains: chainChoiceFits(counterparty, heldToChain) ? choosableChains : [] }}`. Creating a new link replaces the old one (renew). Revoke is the existing `RevokeLink`.
  - `activeLink` and `waitingInvoice` come from `listActivePayeeLinks` and `listWaitingInvoiceLinks`, which each gain an optional `counterpartyId` filter.
  - Under the control, `PayeeLinkHistory` lists the latest 5 links from `payeeLinksOf(orgId, counterpartyId, 5)`. Each link has a state:
    - **Out**: unused, unexpired, unrevoked.
    - **Replaced by a newer link**: `revoked_at` equals a newer link's `created_at`. `create_payee_link` and `create_payee_link_with_options` revoke the earlier unused links in the same transaction that inserts the new one.
    - **Revoked**: any other `revoked_at`.
    - **Expired unused**.
    - **Used**, with the invoice state: sent, waiting until a date, or closed.
  - Each link names who made it: "Made by {email}" from `listMembers`, or "Made by a former member".
  - One footnote says "A used link's status page stays open to the payee for 30 days." This matches `payee_link_status`.
- **CL7 Milestones.**
  - Payees only. Rows are `DecisionRows` items built with `milestoneDecision(milestone, entries, { network, riskLevel, waiting, waitsUntil, links })`, using the same inputs Contractors uses:
    - `waiting` and `waitsUntil` from `milestoneWaiting`;
    - evidence hrefs from `verification_source` plus the Asana and Linear deliverables, read with `asanaOnContractors` and `linearOnContractors` for this counterparty's milestone ids;
    - those hrefs checked with `checkEvidenceLinks`, open milestones first, at most 25 (its own `MAX_LINKS`).
  - Groups: "Open" (pending, verified, held) and "Closed without paying" (closed). Paid milestones are listed under Payments.
  - Hints: an unconfirmed address gives "Address to confirm". A held milestone gives `heldReason(...).hint`, with `reason.text` in `before`. The other waiting states are already in the card's outcome label ("Waiting for an address", "Payee lock wait").
  - Each row's `after` slot holds "Open in Contractors", which goes to `milestoneRowPath(id, { paid })`. Pay now, Close without paying, Verify, escrow and the Asana and Linear cards stay on Contractors.
- **CL8 Bills and invoices.**
  - Rows are `DecisionRows` items from `invoiceDecision(invoice, counterparty, entries, { network, settlements, asOf })` and `rowDate(invoice, today)`.
  - For a payee the section is "Bills from them", with groups "Open" (`OPEN_STATUSES` plus `processing`, by due date, up to 200) and "Rejected" (latest 10).
  - For a client it is "Invoices to them", with groups "Open" and "Received" (`received` or `paid`, latest 10).
  - Each row's `after` slot holds "Open in Bills & receivables", which goes to `invoiceHref(id)`. Verdicts, allocations and variances belong to Bills and stay there.
- **CL9 Payments and receipts.**
  - For a payee: paid milestones and paid payables, merged, newest first by the date each row shows (`milestoneDate`, `rowDate`). The latest 10 show by default; `?history=all#payments` shows up to 500.
  - A milestone's date is `milestoneAt`: for a paid one, its intent's `confirmed_at`, else `executed_at`; otherwise the ledger entry its decision rests on (`milestoneDecidedAt`). With neither read it is null: the row says "Paid" or "Held" with no day, and a paid one sorts last. `milestoneDecision`'s `at` is never shown as a date, since it is the time of the request when no entry was read (amended 2026-11-09).
  - The card footer already gives the transaction, the mint, the evidence and the audit links.
  - Each payable gets a note with its receipt state, shown to every member, as the evidence page does: shared, stopped, none, or unavailable when not paid on chain. A milestone's note is "A milestone has no receipt".
  - A destination different from the current address gives a second note:
    - a `0x` destination: "Paid to an earlier address" with `Hash` and the explorer link;
    - a `blindpay:` destination: "Paid to their bank account through BlindPay";
    - a `sim:` destination: the simulated line.
  - `footerAction` holds the existing receipt control (share, renew, revoke) when `shareReceipts && receiptShareable(invoice, decision)`. While the receipts part is unread it gets `shared={null}` and offers no button, only why: sharing renews a shared receipt's token, which would stop the link its payee holds (amended 2026-11-09).
  - For a client the section is "Payments from them": received invoices, with a transaction link where `tx_ref` is a `0x` hash, and no receipt state (receipts are for payables, P6).
  - The tiles and section totals are per currency ("120 USDC · 40 EURC"). USDC and EURC are never added together.
  - Totals use every row read (CL13), not just the rows shown.
- **CL10 Documents.**
  - Payees only.
  - Document requests on the shown bills come from `readDocumentRequests(invoiceIds, db(), now)` and are drawn with `DocumentRequestLine`, with `canRevoke={write}`, each view through `visibleRequest` first (CL12). The file link is the existing members-only route.
  - Below them is "Invoices sent for review": `sentDraftsFrom(counterpartyId, 20)` (state `sent`, this counterparty), which holds what the browser extension captured and what the payee sent through their payee link (0133's `source 'payee_link'`). These link to `billsHref({ tab: "bills", review: "captured" })` (amended 2026-11-09: it was named for the browser extension alone).
  - Before 0121 the drafts part says "Not read" (`isMissingRelation`).
- **CL11 History.**
  - Comes from `listCounterpartyEntries(counterpartyId, 25)`: `seq, ts, actor, action, summary` only, from `domain = "compliance"` entries with `detail->>counterpartyId`, `seq` descending.
  - It sits in a folded `Disclosure` with id `history`.
  - Each line links to `entryHref(slug, seq)`, where the Audit log checks the entry's signature. A last line links "All of it in the Audit log" to `/audit?domain=compliance`.
  - No `detail` is read. Summaries are written by us and name no one.
- **CL12 Untrusted text.**
  - `visibleText(text, max)` in the new `src/lib/visible-text.ts`:
    - drops the `NOTE_INVISIBLE` classes: `\p{Cf}`, `\p{Cs}`, `\p{Default_Ignorable_Code_Point}`, `\p{Co}`, `\p{Cn}` and U+2800;
    - turns `NOTE_BREAK` (`\p{Cc}`, `\p{Zl}`, `\p{Zp}`) into a space;
    - keeps at most two combining marks in a row;
    - trims, and cuts at `max` with an ellipsis.
  - `src/lib/document-requests/check.ts` imports these classes rather than keeping its own copy.
  - `UntrustedText` wraps the result in `<bdi>`. It is used for the counterparty's name, lookalike names, milestone titles, invoice numbers and memos, and draft fields.
  - Names and titles go through `visibleText` before they reach `milestoneDecision` and `invoiceDecision`. The breadcrumb crumb is `visibleText(counterparty.name, 80)`. `CounterpartyProfile`, `CounterpartyAddressBlock` (with `AddressCheckNote`'s "is frozen" callout), `CounterpartyPayoutBlock` and `PayeeLinkControl` get the row with that cleaned name.
  - A document request's note keeps its lines: `visibleLines(text, max)` cleans each line as `visibleText` does, leaves out a line with nothing visible, and cuts the whole at `max`. `visibleRequest` (in `page-view.ts`) runs the note through it and the purchase order number through `visibleText`, for the request and for what was sent with an earlier one (`received`), before `DocumentRequestLine` draws them (amended 2026-11-09).
- **CL13 Reads and refresh.**
  - The counterparty is read first. Every other part then runs in parallel and best effort. A failed part renders "Not read just now. Reload the page in a moment.", and its tile says "Not read".
  - This counterparty's invoices and milestones are paged by 1000.
  - Ledger entries for targets are read in chunks of 25 ids, `ENTRY_ID_CHUNK`, because the RPC returns at most 1000 rows. A chunk that `ledgerReadMayBeCut` adds "Some of this record's history was not read; the Audit log has all of it."
  - Intents and receipt states are read in chunks of 100 ids (`ID_CHUNK`).
  - `AutoRefresh` uses `counterpartiesRefreshMs({ linksOut: activeLink ? 1 : 0, unconfirmed: state === "unconfirmed" ? 1 : 0 })`.
  - The page has no `maxDuration`. `AskEveryPayee` and its 300 s stay on the list.
- **CL14 Nothing here pays, and nothing new is recorded.**
  - The page reuses these actions, each with its existing signed ledger entries:
    - limit edit (`counterparty_limit_changed`);
    - billing email (`counterparty_notice_email_changed`);
    - purchase orders (`counterparty_purchase_orders_changed`);
    - address edit and mirror (`counterparty_address_changed`);
    - confirm (`counterparty_address_confirmed`);
    - unfreeze (`counterparty_unfrozen`);
    - dismiss a screening match (`screening_match_dismissed`);
    - statement check (`vendor_statement_checked`);
    - bank account (`counterparty_bank_account_set`);
    - payee link create and revoke (`payee_link_created`, `payee_link_revoked`);
    - receipts (`receipt_shared`, `receipt_link_renewed`, `receipt_revoked`);
    - document request revoke (`document_request_revoked`).
  - No action, ledger action, table or column is added.
- **CL15 Deep links.**
  - The new `src/lib/counterparty-paths.ts` (pure) holds:
    - `COUNTERPARTY_SECTIONS`;
    - `counterpartyPath(id, section?)`, which gives `/counterparties/<id>[#section]`, or `/counterparties` for `""`;
    - `counterpartyIdOf(param)`;
    - `milestoneAnchor(id)` (`milestone-<id>`);
    - `milestoneRowPath(id, { paid })`, which gives `/contractors#milestone-<id>`, or `/contractors?history=all#milestone-<id>` when paid.
  - `src/lib/next-step.ts` re-exports `counterpartyPath` and maps each rule to its section:
    - `payment_limit` to `limit`;
    - `no_address`, `address_unconfirmed`, `cooling_off` and `invoice.pay_to_differs` to `address`;
    - `unscreened` and `high_risk` to `screening`;
    - `MATCH_INCOMPLETE` to `purchase-orders`.
  - Every place that links to a counterparty, a milestone or a payee link changes in PR A (see Files). Emails keep their button text "Open Counterparties": the page sits in that section, and a name inside an email button would be untrusted text.
  - Chat notices, the activity feed and the transfer watch change in PR B.
- **CL16 Navigation.**
  - `SUBPAGES` gains `{ pattern: /^\/o\/[^/]+\/counterparties\/[^/]+/, section: "counterparties", label: "Counterparty" }`.
  - The page exports the static `export const metadata: Metadata = { title: "Counterparty" };`. `crumb` is the visible name.
  - A back link "All counterparties" (with `ArrowLeft`) goes to `/counterparties#counterparty-<id>`, which opens that row.
- **CL17 Analytics.**
  - `redactPath` also turns every UUID path segment under `/o/:org` into `:id`. That covers this page, `/projects/:id` and `/evidence/:kind/:id`.
  - Titles and referrers follow, because they use `redactPath`. Only the pathname is sent, never the hash or the query.
  - The privacy page says so, with a new "updated" date.
  - GA4 enhanced measurement's outbound clicks would send an explorer URL, and an explorer URL contains the payee's address. Transaction links already do this today. Turning it off is an owner step.
- **CL18 Words and docs.**
  - Copy is plain English, as in "UI words".
  - Platform copy says "Arc". "Arc testnet" appears only in the mirror line, which is a testnet-only feature.
  - The page never says "AP agent" or "small teams".
  - The guide, CHANGELOG and ARCHITECTURE change in the same PR (see Docs). There is no `/api/v1` or webhook change, so `content/docs/changelog.mdx` gets no entry. The evidence document is unchanged because `EvidenceChain.subject` is unchanged (CL9, Files).

## Who sees and does what

| | owner, admin | approver | accountant (co-sign off) | accountant (co-sign on) | viewer |
|---|---|---|---|---|---|
| Open the page, Profile, address, milestones, bills, payments, documents, History | yes | yes | yes | yes | yes |
| Receipt state on payments | yes | yes | yes | yes | yes |
| Edit limit, billing email, purchase orders, address, mirror; unfreeze | yes | no | no | no | no |
| Confirm a changed address | yes | yes | no | yes | no |
| Dismiss a screening match | yes | yes | no | no | no |
| Check a vendor's statement | yes | no | yes | yes | no |
| Payee link section: see, create, renew, revoke, history | yes | no | no | no | no |
| Share, renew, revoke a receipt (live workspace) | yes | no | no | no | no |
| Revoke a document request | yes | no | no | no | no |
| Bank account | as on the list (`integrations.manage` and BlindPay set) | | | | |

Two of these differences are deliberate:

- Receipt state is shown to every member, which Bills does not do; the evidence page already does. The page shows only the state, never the link.
- History lines like "Created a one-time link for a payee…" are visible to every member, because the Audit log already shows them.

## Files

**Added**

- `src/app/o/[slug]/counterparties/[id]/page.tsx`: the page (CL1–CL17).
- `src/lib/counterparty-paths.ts`: sections, paths, `counterpartyIdOf`, milestone anchors (CL15).
- `src/lib/visible-text.ts`: `visibleText`, `visibleLines` and the shared character classes (CL12).
- `src/lib/counterparties/page-grants.ts`: `pageGrants` (CL3).
- `src/lib/counterparties/page-view.ts`, all pure:
  - `addressFacts`;
  - `payeeLinkStates`;
  - `paymentRows` (merge, order, cap) and `milestoneAt` (CL9);
  - `totalsByCurrency`;
  - the bill, invoice and milestone groupings;
  - `visibleRequest` (CL10, CL12);
  - `tiles`.
- `src/lib/counterparties/page-read.ts`: `readCounterpartyPage(counterparty, { orgId, grants, network, now, history })`. It returns each part as `{ read: true, value } | { read: false }`.
- `src/lib/milestone-date.ts`: `milestoneDate`, moved from the bottom of `contractors/page.tsx` so both pages use it. It takes a null time too, and then names the state without a day (CL9).
- `src/components/CounterpartyDetails.tsx`, server components with no tenant-data value imports:
  - `CounterpartyProfile`: `ScreeningMatch`, `PerformanceHistory`, and the six-line `dl` (Configured limit, Allowed now, Jurisdiction, Last screened, Billing email, Purchase orders);
  - `CounterpartyAddressBlock`: `CounterpartyAddress`, `AddressCheckNote`, the mirror note, `MirrorAddressControl`;
  - `CounterpartyPayoutBlock`: `VendorStatementCheck`, `CounterpartyBankAccount`;
  - `CounterpartyDetails`, which composes them with `PayeeLinkControl` for the list. On the list, one thing moves: the mirror note and control move up beside the address they stand in for.
- `src/components/vx/UntrustedText.tsx` (CL12).
- `src/components/counterparty/PayeeLinkHistory.tsx`, `CounterpartyHistory.tsx`, `SentDrafts.tsx`.

**Changed (PR A)**

- `src/app/o/[slug]/counterparties/page.tsx`:
  - rows render `CounterpartyDetails`, so the `dl` at :241-288 and the blocks at :289-340 move;
  - rows pass `pageHref`;
  - reads are unchanged.
- `src/components/CounterpartyRow.tsx`: optional `pageHref`, which puts "Open their page" at the top of the opened row. The Disclosure id `counterparty-<id>` stays.
- `src/components/intake/CounterpartyAddressEdit.tsx`: optional `full`, `explorerHref`, `copyable` and `copyNote` (CL5). Without them the list renders as today.
- `src/components/vx/DecisionRows.tsx`: `DecisionRowItem.anchor?: string`, passed to `Disclosure id`.
- `src/components/vx/map.ts`: `milestoneDecidedAt(milestoneId, entries)`, the time of the entry `milestoneDecision` rests on, or null (CL9).
- `src/components/ReceiptControl.tsx`: `shared` may be null, for a receipt whose state was not read: no button then (CL9).
- `src/app/o/[slug]/contractors/page.tsx`:
  - rows get `anchor: milestoneAnchor(milestone.id)`;
  - `after` starts with "Open their page" (`counterpartyPath(milestone.contractor_id)`);
  - the "Address to confirm" callout says "Confirm it on their page" and links `counterpartyPath(milestone.contractor_id, "address")` as "Open their address";
  - `waitingFor` (:243-263) passes `id: milestone.contractor_id`;
  - `milestoneDate` is imported.
- `src/lib/agent/milestone-decisions.ts`:
  - `HeldFacts.contractor.id?: string`;
  - when it is set, `blocked()`, `unscreened` and `new_payee` link `{ label: "Counterparty", path: counterpartyPath(id, section) }` (screening for risk and screening limit, `limit` for above limit, `address` for the address states and for new payee);
  - without it they keep `COUNTERPARTIES`;
  - the server facts (~:507-520) pass `contractor.id`.
- `src/lib/next-step.ts`: re-exports `counterpartyPath` and maps sections (CL15).
- `src/components/vx/ApprovalCard.tsx`: :514 `COSIGN_BLOCKED` links `counterpartyPath(id, "address")`, labelled "Confirm address". :809 and :818 follow `ruleNextStep`.
- `src/components/vx/bill-next-step.ts`: :60 links to the section.
- `src/components/.../PayLinkControl.tsx`: :126 "Add billing email" goes to `counterpartyPath(id, "billing-email")`.
- `src/lib/accountant/read.ts`:
  - :261 `milestoneRowPath(row.id, { paid: false })`;
  - :345 `counterpartyPath(row.id, "address")`;
  - :686 `milestoneRowPath(link.milestone_id, { paid: false })`.
- `src/components/vx/PaymentsInFlight.tsx`: :42-44 the milestone `cardHref` becomes `milestoneRowPath(id, { paid: false })`.
- `src/lib/evidence-read.ts`: `EvidenceRead.counterpartyId: string | null`, from the local `counterpartyId`. `chain.subject` is not changed, because `evidenceDocument` and `GET /api/v1/invoices/{id}/evidence` publish it.
- `src/components/vx/EvidenceChain.tsx`: `EvidenceChainView` takes an optional `payeeHref`, and the payee name in `EvidenceSubject` links to it.
- `src/app/o/[slug]/evidence/[kind]/[id]/page.tsx`: passes `payeeHref = counterpartyPath(read.counterpartyId)` when it is set.
- `src/app/actions/pay-freelancer.ts`: `PayFreelancerResult` gains `counterpartyId`, which `src/lib/pay-freelancer.ts:197` already returns.
- `src/components/intake/PayFreelancerForm.tsx`: `PaymentLinkReady` takes `pageHref` and says "It is shown only now; make a new one on their page if it is lost."
- `src/lib/notifications/payee-address.ts`: the link at :30 goes to `/o/${slug}/counterparties/${link.counterparty_id}#address` (the notice gets it from :443-450 of `payee-links.ts`).
- `src/lib/address-change-check.ts`: `notifyDisputed` (:288-298) links the same way, using the `counterpartyId` at :248. Button text unchanged.
- `src/components/vx/nav.ts`: the `SUBPAGES` row (CL16).
- `src/lib/analytics/redact.ts`: `:id` (CL17). `src/app/privacy/page.tsx`: the text and the `updated` date.
- `src/lib/document-requests/check.ts`: imports the classes from `visible-text.ts`.
- Readers:
  - `src/lib/queries.ts`:
    - `readCounterparty(id)` (`select("*")`, `maybeSingle`);
    - `payeeAddressBook()` (`id, name, address, chain`, paged by 1000);
    - `listInvoicesOf(counterpartyId)` and `listMilestonesOf(counterpartyId)` (paged by 1000, same selects and mappers as `listInvoices` and `listMilestones`, mappers shared);
    - `frozen_at` on `CounterpartyRow`.
  - `src/lib/platform/payee-links.ts`:
    - `payeeLinksOf(orgId, counterpartyId, limit)` selects `id, created_at, expires_at, used_at, revoked_at, created_by, asks_invoice, invoice_at, invoice_closed_at`. On `42703` (before 0133) it falls back to the 0039 columns.
    - `listActivePayeeLinks` and `listWaitingInvoiceLinks` get an optional `counterpartyId`.
  - `src/lib/receipts/share.ts`: `receiptStatesOf(invoiceIds)` selects `invoice_id, revoked_at` from `payment_receipts`, chunked by 100.
  - `src/lib/settlement-read.ts`: `readIntentsFor({ invoiceIds, milestoneIds })` selects `INTENT_COLUMNS` plus `destination`, chunked by 100. Destinations are kept in their own map and never added to `IntentRecord`.
  - `src/lib/invoice-drafts/store.ts`: `sentDraftsFrom(counterpartyId, limit)` selects `id, source, invoice_number, amount, currency, sent_at`, with `state = 'sent'`, newest first. `capturedDraftsToReview` is unchanged.
  - `src/lib/ledger.ts`: `listCounterpartyEntries(counterpartyId, limit)` (CL11).

**Changed (PR B)**

- Milestone and counterparty links in:
  - `src/lib/agent/transfer-watch.ts:293`;
  - `src/lib/agent-activity.ts:274, :288, :295, :329`;
  - `src/lib/slack/blocks.ts:321`;
  - `src/lib/telegram/messages.ts:243`;
  - and the Discord notice builder that mirrors Slack.
- They use `milestoneRowPath` and `counterpartyPath`.

## Data

- **Read only.** The page reads these tables: `counterparties`, `invoices` and `milestones` (this counterparty), `payment_intents` (their ids), `payment_receipts` (their paid payables), `document_requests` (the shown bills), `invoice_drafts` (sent, naming them), `ledger_entries` (targets and compliance), `payee_links` (platform, writers only), and members.
- **Writes:** none. **Migration:** none. **Index:** none.
  - The History query has no index on `detail->>counterpartyId`. It is the same filter the evidence page already uses, cut to 25 rows and filtered by `org_id`.

## Permissions

There are no new permissions. Every grant is an existing `PERMISSIONS` entry put together by `pageGrants` (CL3). The page passes the access-gates rules unchanged: `await params`, `requireMembership`, `inOrg`, `dynamic = "force-dynamic"`, and no tenant-data value imports in components.

## Ledger actions

None added. CL14 lists the existing entries the reused controls write. History reads compliance entries only. Receipt entries (`ap`) appear in Payments as receipt state.

## UI words

- Sub text for a payee: "{Contractor|Vendor} · paid on {chain label}. Everything Vestiarion holds about them, in one place. Nothing here makes a payment: the agent pays under its rules, and people decide in Approvals and on Contractors."
- Sub text for a client: "Client. Everything Vestiarion holds about them, in one place."
- Tiles (`StatTile`):
  - "Owed to them" ("Owed by them" for a client);
  - "Paid to them" ("Paid by them");
  - "Address": Confirmed / Set when added / To confirm / Frozen / None;
  - "Payee link" (writers, payees): "Out · expires {date}" / "Waiting for their invoice · until {date}" / "None out".
  - A tile whose part failed says "Not read".
- Address:
  - "Open on the explorer";
  - "Copy address";
  - "Copy comes back once someone confirms this address.";
  - "Frozen: copy comes back once an owner or admin unfreezes it.";
  - "Copy is off: this address looks like {name}'s. Check every character on the explorer.";
  - "Not a chain this workspace pays on, so there is no explorer link."
- Payee link:
  - states: "Out · expires {date}", "Replaced by a newer link · {date}", "Revoked · {date}", "Expired unused · {date}", "Used · {date}", "Invoice sent · {date}", "Waiting for their invoice · until {date}", "Invoice closed";
  - "Made by {email}" / "Made by a former member";
  - "A used link's status page stays open to the payee for 30 days.";
  - "The latest 5 links; every one is in History and the Audit log.";
  - "An owner or admin sends and stops payee links."
- Sections:
  - "Profile", "Payment address", "Payee link", "Milestones" ("Open", "Closed without paying"), "Bills from them" ("Open", "Rejected"), "Invoices to them" ("Open", "Received"), "Payments", "Payments from them", "Documents" ("Document requests", "Invoices sent for review"), "History";
  - "Show every payment" / "Show the latest 10";
  - "All of it in the Audit log".
- Row links: "Open in Contractors", "Open in Bills & receivables", "Open their page", "Open their address".
- Payments notes:
  - "Receipt shared", "Receipt link stopped", "No receipt shared", "No receipt: not paid on chain", "A milestone has no receipt";
  - "Paid to an earlier address {short}";
  - "Paid to their bank account through BlindPay";
  - "A simulated payment: nothing moved on chain."
- Empty states: "No milestones yet.", "No bills from them yet.", "No invoices to them yet.", "No payments yet.", "Nothing asked for or captured yet.", "No changes recorded yet."
- Failures:
  - "Not read just now. Reload the page in a moment.";
  - "This counterparty could not be read just now. Reload the page in a moment.";
  - "Some of this record's history was not read; the Audit log has all of it."
- Back link: "All counterparties".

## Docs

- `content/docs/guides/pay-a-contractor.mdx`:
  - a new section "## One page for each contractor" after "## 5. Read it in the audit log", covering what each section shows, who acts where, copy and the explorer, and payee link states;
  - :61, :67 and :121 say the row opens their page;
  - :65 stays.
- `content/docs/guides/first-payment.mdx`: :422 becomes "Edit limit or Confirm address opens that part of the counterparty's page" and :587 becomes "Review screening opens their screening".
- `content/docs/guides/workspace.mdx`, "## The header": adds Counterparty to the list of pages inside a section.
- `content/docs/guides/evidence-and-receipts.mdx`, "## 7. Share a receipt": a receipt can also be shared from Payments on their page. The "Who does what" table (:12) gains the receipt-state row.
- `CHANGELOG.md` [Unreleased]:
  - under Added: `- **One page for each counterparty**,\n  [Guide](https://www.vestiarion.xyz/docs/guides/pay-a-contractor#one-page-for-each-contractor):\n  …`;
  - under Changed: the analytics `:id` redaction and every "fix it" link opening its part of the page.
- `ARCHITECTURE.md`:
  - a new "## The counterparty page" before "## Projects: budgets and the money set aside" (:2046), covering parts, grants, reads, chunking and deep links;
  - the `SUBPAGES` paragraph (:1516-1526) gains the new row;
  - the GA paragraph (~:959) covers `:id` and outbound clicks;
  - "## Why it was paid: the evidence chain" (:2186) notes that `payeeHref` is not in the document.
- This spec: `docs/superpowers/specs/2026-11-09-counterparty-page-design.md`.

## Tests

**New**

- `tests/counterparty-paths.test.ts`: sections, `""` to the list, UUID check and lowercase, milestone paths (CL15).
- `tests/visible-text.test.ts`: each class dropped, breaks to spaces, combining marks capped at 2, the cut; `visibleLines` keeping lines. The document-request note tests still pass (CL12).
- `tests/counterparty-page-grants.test.ts`: the role matrix row by row, co-sign on and off, live and not live (CL3).
- `tests/counterparty-page-view.test.ts`:
  - `addressFacts` for all five states;
  - copy rules;
  - `payeeLinkStates`, including "replaced" with equal timestamps and "used" within and after 30 days;
  - `paymentRows` order and cap, a milestone with no time last;
  - `milestoneAt` and `milestoneDate` with no time read;
  - `visibleRequest`, with an earlier answer under a newer request;
  - per-currency totals never summed;
  - groups by status (CL5, CL6, CL8, CL9).
- `tests/counterparty-page-read.test.ts`, with a fake db:
  - platform reads filter `org_id` and the row's id;
  - no `token_hash` in any select;
  - a non-writer makes no `payee_links` read;
  - one failed part leaves the rest;
  - ledger chunks of 25 and the cut note (CL2, CL4, CL13).
- `tests/counterparty-page.test.tsx`, in the `evidence-page.test.tsx` pattern (mocked membership, scope, reader, queries, shell status, circle, ProductShell; `renderToStaticMarkup`):
  - an invalid id and another workspace's id are both 404;
  - a reader that throws gives the held callout;
  - a viewer sees History and receipt state but no payee-link section and no Copy on an unconfirmed address;
  - a writer gets `PayeeLinkControl` with `offers`;
  - an accountant gets Confirm address while co-signing, and not otherwise;
  - receipts unread: no Share receipt, New link or Stop sharing;
  - a paid milestone dated by its payment, with no day and last when nothing about it was read;
  - a request note, a purchase order number and a frozen payee's name without bidi or zero-width characters;
  - a payee-link draft under "Invoices sent for review";
  - a client has no payee-link, milestones or documents section;
  - an explorer link only for `0x`;
  - each section id appears exactly once;
  - no `vxp_` or `vxr_` in the markup;
  - static metadata "Counterparty".
- `tests/payee-chains.test.ts`: `addressOnChainUrl` on every payee chain of both networks, a non-hex address, `ChainNotOnNetworkError`.

**Updated**

- `tests/control-ui.test.tsx`:
  - :652-660 now read `src/components/CounterpartyDetails.tsx` (Billing email block, `<CounterpartyNoticeEmailEdit`, no `role !== "client"` within 260 characters before `Billing email</dt>`);
  - :856, :893 and :1011 expect section paths.
- `tests/docs-guides.test.ts`:
  - :1655, :1656, :1714 and :3576 point at a new `COUNTERPARTY_DETAILS` const;
  - :822, :1578 and :1579 stay on `COUNTERPARTIES_PAGE`;
  - new pairs for the guide's quoted words against the new page.
- `tests/mirror-address-ui.test.tsx` :63-68, `tests/counterparty-address-ui.test.tsx` :133-136 and `tests/counterparty-purchase-orders-ui.test.tsx` :36-44 now read `CounterpartyDetails.tsx`.
- `tests/network-copy-ratchet.test.ts` :99: counterparties page 1 → 0, `CounterpartyDetails.tsx` 1, new page 0.
- `tests/decision-rows.test.tsx`:
  - :162 expects `counterpartyPath(milestone.contractor_id, "address")` and "Open their address";
  - new cases for `anchor`;
  - :167-170 unchanged.
- `tests/milestone-decisions.test.ts`: :159 unchanged (no id); a new case for the counterparty link when an id is given.
- `tests/held-milestone-actions.test.tsx`: renders "Open Counterparty".
- `tests/approval-card-cosign.test.tsx` :110-111, `tests/pay-links-ui.test.tsx` :264, `tests/bill-next-step.test.ts` :56, `tests/accountant-handoff-build.test.ts` :142, `tests/accountant-portfolio.test.ts` :423 and `tests/payments-in-flight.test.tsx` :97: new paths.
- `tests/payee-address-notify.test.ts` :55 and `tests/address-change-check.test.tsx` :308: links to the page with `#address`, button text unchanged.
- `tests/navigation.test.ts`: a subpage case (:129-147), `NESTED_PAGES` (:169), the crumb list (:189-197).
- `tests/docs-links.test.tsx`: the SECTIONS row for the new guide section. `tests/mainnet-copy-pages.test.tsx`: the new page in `PAGES` (:19).
- `tests/analytics-redact.test.ts`: `:id` on the three detail pages, a non-UUID segment kept, token paths unchanged. `tests/legal-pages.test.tsx`: :40 date, :495 text, :189 still holds.
- `tests/evidence-read.test.ts`: `counterpartyId`; the v1 evidence document is unchanged. `tests/evidence-page.test.tsx`: payee link. Pay-freelancer action and form tests: `counterpartyId`, `pageHref`.
- `tests/payee-links.test.ts`, `tests/receipts-share.test.ts`, `tests/settlement-read.test.ts`, `tests/ledger.test.ts`: the new readers.
- `tests/ui-consistency.test.ts` must pass on the new MDX lines.

## Rollout

- PR A ships chunks C1–C7. C2 (analytics) may merge first on its own, with its docs. PR B (C8) follows once PR A is live.
- After each deploy, reload open app tabs (skew protection).
- Read-only smoke test on production: owner and viewer pages for a contractor, a vendor and a client; a 404 for a foreign id; each "fix it" link landing on its section.
- After the smoke test, we post on Canteen and add a beta.16 notes line.

## Out of scope

- New actions, ledger actions, tables, columns or indexes. An index on `detail->>counterpartyId` would be a migration.
- Pay now, Close without paying, Verify, escrow, and Asana or Linear acceptance on the page. Those stay on Contractors and Approvals.
- Showing a payee or receipt URL again, ever.
- Notes, tags, file uploads or merging duplicate counterparties.
- Links from Bills & receivables rows and Approvals cards beyond the fix paths (later).
- A `/api/v1` counterparty summary, webhooks, SDK and CLI.
- A page or portal for the contractor themselves.
- Search across counterparties.

## Open risks

- A receipt row pushed past the latest 10 by a refresh unmounts a link that was just shown. Renew makes a new one.
- The History query is unindexed. It is filtered by `org_id`, limited to 25, and is the same as the evidence page's query.
- Until the owner turns off outbound clicks, GA receives explorer URLs. Transaction links already send them today.
- Receipt state and History are visible to every member, wider than Bills (the evidence page and Audit log already do this).

## Owner steps

1. Nothing to run: no migration, no environment variable, no flag.
2. Decide on GA4 outbound clicks: Admin > Data streams > the web stream > Enhanced measurement > Outbound clicks. We recommend turning them off, because explorer links carry a payee's address.
3. After C2 is live, open a counterparty page and check in GA4 Realtime or DebugView that the path reads `/o/:org/counterparties/:id`.
4. Choose whether we prove Create link and Revoke live on a sample contractor in pinecrest, or rely on tests and the read-only smoke test. Do not confirm an address on a payee with a verified milestone in pinecrest: a cycle can pay it.

## Implementation plan

1. **C1 Pure helpers.**
   - Files: `src/lib/counterparty-paths.ts`, `src/lib/visible-text.ts` (and the import in `src/lib/document-requests/check.ts`), `addressOnChainUrl` in `src/lib/payee-chains.ts`, `src/lib/counterparties/page-grants.ts`, `src/lib/counterparties/page-view.ts`, `src/lib/milestone-date.ts` (Contractors imports it).
   - Tests: `counterparty-paths`, `visible-text`, `payee-chains`, `counterparty-page-grants`, `counterparty-page-view`.
2. **C2 Analytics redaction** (independent).
   - Files: `src/lib/analytics/redact.ts`, `src/app/privacy/page.tsx`, the ARCHITECTURE GA paragraph, CHANGELOG Changed.
   - Tests: `analytics-redact`, `legal-pages` :40 and :495.
3. **C3 Readers.**
   - Files: `queries.ts` (`readCounterparty`, `payeeAddressBook`, `listInvoicesOf`, `listMilestonesOf`, shared mappers, `frozen_at`), `platform/payee-links.ts` (`payeeLinksOf`, optional filters), `receipts/share.ts` (`receiptStatesOf`), `settlement-read.ts` (`readIntentsFor`), `invoice-drafts/store.ts` (`sentDraftsFrom`), `ledger.ts` (`listCounterpartyEntries`), `evidence-read.ts` (`counterpartyId`), `counterparties/page-read.ts`.
   - Tests: `payee-links`, `receipts-share`, `settlement-read`, `ledger`, `evidence-read`, `counterparty-page-read`.
4. **C4 Components.**
   - Files: `DecisionRows.tsx` (`anchor`), `CounterpartyAddressEdit.tsx` (`full`, `explorerHref`, `copyable`, `copyNote`), `CounterpartyDetails.tsx` with the list page and `CounterpartyRow.tsx` (`pageHref`), `UntrustedText.tsx`, `PayeeLinkHistory.tsx`, `CounterpartyHistory.tsx`, `SentDrafts.tsx`.
   - Tests: the pinned-source moves in `control-ui`, `docs-guides`, `mirror-address-ui`, `counterparty-address-ui`, `counterparty-purchase-orders-ui` and `network-copy-ratchet`; `decision-rows` anchor; `invoice-intake-form`, `decision-rows` :167-170 and `sample-data-ui` :71 still pass on the list.
5. **C5 The page and navigation.**
   - Files: `src/app/o/[slug]/counterparties/[id]/page.tsx`, the `SUBPAGES` row in `nav.ts`.
   - Tests: `counterparty-page`, `navigation`, `mainnet-copy-pages`, the new `docs-guides` pairs.
6. **C6 In-app deep links and emails.**
   - Files: `next-step.ts`, `ApprovalCard.tsx`, `bill-next-step.ts`, `PayLinkControl.tsx`, `accountant/read.ts`, `PaymentsInFlight.tsx`, `milestone-decisions.ts` (`HeldFacts.contractor.id`, server facts), `contractors/page.tsx` (anchors, links, `waitingFor` id), `EvidenceChain.tsx` with the evidence page (`payeeHref`), `actions/pay-freelancer.ts` with `PayFreelancerForm.tsx`, `notifications/payee-address.ts`, `address-change-check.ts`.
   - Tests: `approval-card-cosign`, `control-ui`, `pay-links-ui`, `bill-next-step`, `accountant-handoff-build`, `accountant-portfolio`, `payments-in-flight`, `milestone-decisions`, `held-milestone-actions`, `decision-rows` :162, `evidence-page`, the pay-freelancer tests, `payee-address-notify`, `address-change-check`.
7. **C7 Docs.**
   - Files: `pay-a-contractor.mdx`, `first-payment.mdx`, `workspace.mdx`, `evidence-and-receipts.mdx`, CHANGELOG Added and Changed, the ARCHITECTURE sections, this spec file.
   - Tests: `docs-links` SECTIONS, `docs-guides`, `ui-consistency`; then `npm run verify`.
8. **C8 PR B: chat and activity links.**
   - Files: `transfer-watch.ts`, `agent-activity.ts`, `slack/blocks.ts`, `telegram/messages.ts`, the Discord builder, CHANGELOG Changed.
   - Tests: `agent-activity` (:322), the Slack, Telegram and Discord message tests.