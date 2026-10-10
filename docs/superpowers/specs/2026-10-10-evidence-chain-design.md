# Why it was paid: one evidence chain per payment

Date: 2026-10-10. Status: decided (autonomy grant 2026-10-05). Roadmap: F22, with I22 (how each link is known) and
I24 (links outside are checked where we can).

## Why

When an owner, an accountant or an auditor asks "why was this paid?", the answer is spread over the bill's card, its
purchase order number, the goods received box, the counterparty's address and screening, the decision trail, the
approvals, the explorer and the receipt. Nothing says which of those links code or a third party checked and which a
person only stated. A signed ledger entry is easy to read as more than it is: it proves the workspace recorded a fact,
and when, not that the fact is true.

## Decisions

**E1. One page per payment, inside the workspace.**
- `/o/<slug>/evidence/invoice/<id>` for a payable, `/o/<slug>/evidence/milestone/<id>` for a contractor milestone.
  The address is stable: it names the record, not a payment attempt.
- Every member may read it (`requireMembership`), viewers included, as they may read the audit log. The page awaits its
  params, then `requireMembership`, then reads inside `inOrg`, like every workspace page.
- A receivable, an id the workspace does not hold, or another workspace's id answers the workspace's not-found page.
- Paid or not: an open payable or milestone shows the chain so far, read-only, and says it is not paid yet.
- Cost if wrong: a rename later needs a redirect.

**E2. The chain, in order.** Each step is a list of facts; each fact carries how it is known (E3).
1. **What was agreed.** A payable: its purchase order number, who entered it and when, or that the counterparty is
   paid without purchase orders (who marked it). A milestone: its terms (title, amount, payee) and who added it, from
   where (the console, the API, a bounty on GitHub).
2. **What was delivered.** A payable: goods or services marked received, by whom and when. A milestone: the merged
   pull request GitHub reported, a person's verification by hand with the evidence link they gave, or sample data.
3. **The bill** (payables only; a milestone is its own request to pay): who added it and from where: the form, a
   document read by a model, a CSV import, an email, Telegram, Slack, the API, a recurring schedule, sample data.
4. **The payee.** The address paid; who gave it (a member, the payee through their payee link or GitHub, or a mirror
   address Vestiarion made in shadow mode) and who confirmed it; the screening result before the payment and its
   source; any screening match a person dismissed.
5. **The decision.** Who decided (the model by name, or the written policy), whether the written policy agreed, and
   what code checked before anything was sent, as the decision trail words it. It links into the trail on AP / AR
   rather than repeating its steps.
6. **People.** Approvals (Approve and pay, Pay now, a first of two approvals), verdicts in shadow mode, returns and
   rejections before the payment. When nobody stepped in: "No person approved it: code let the agent pay it within the
   workspace's rules."
7. **The payment.** The transaction on the network it was made on, linked to its explorer, the signed entry that
   records it, and Arc's own record of it (E4).
8. **The receipt** (payables only; receipts exist for bills, payment receipts P1): shared or not, its signed entry,
   and whether its link still opens. The link itself is never shown again: only its hash is stored.
9. **Signatures.** Every entry the chain cites and every entry about the record, each checked on the server and again
   in the reader's browser with the receipt page's verifier (`verifyEntry`, Web Crypto).

**E3. How each fact is known (I22).** One of five, plus two outcomes of a check:
- **Checked by code**: a rule Vestiarion runs computed it: the three-way match, the guardrails, the new payee check,
  the spending-limit contract's verdict, a signature, a mirror address made by code, the written policy deciding.
- **Verified outside**: a third party said so: Arc's record of the transaction, GitHub's answer about a pull request,
  the screening service (OpenSanctions).
- **Stated by a person**: a member, or the payee, entered it. The fact names who (by email, E8) and when.
- **Inferred**: read, not recorded: the model's judgement (it decides from facts it was given), a bill loaded with
  sample data and no entry of its own, a setting read as it is today because the decision did not record it.
- **Missing**: shown, with what would fill it ("A person marks the goods received with Add details on AP / AR").
- **Could not open**: a check we make that got no answer, or a link revoked. Never "verified".
- **Does not match**: a check that answered and contradicts the record (a transaction without this transfer, a
  signature that does not verify).

A step reads as its weakest fact, in this order: Does not match, Could not open, Missing, Inferred, Stated by a person,
Checked by code, Verified outside. So a step is never labelled above what its least-supported fact is.

**Never upgraded.** The label of a fact is decided by where the fact came from, never by the entry that recorded it.
Goods marked received by a person stay "Stated by a person" though the entry is signed. The signatures step says, in
one plain line: "A signed entry proves who recorded what, and when. It does not prove the goods were good or the work
was done."

**E4. Links outside (I24).**
- Shown as links: a deliverable URL a person gave, a pull request, a bounty comment, the explorer.
- Checked here, cheaply, on every view: the signed entries (E2.9); our own receipt (its entry verifies, names the
  entry that records this transaction, and its link is not revoked); and the transaction we recorded, read from the
  chain's public RPC with `eth_getTransactionReceipt` (`readOnChain`, 4 s, a mined receipt remembered per instance),
  which must hold a transfer of the amount to the payee.
- Not fetched: any URL a person or a payee typed. Fetching it from the server would let a payee make our server call an
  address of their choosing, and a deliverable page proves nothing a person did not state. Its fact stays "Stated by a
  person" and the link is marked "Not opened by Vestiarion".
- GitHub is not asked again here: the verification cycle asked it with the workspace's own token, and the fact says
  when. An answer GitHub did not give (`unavailable`, `failed`) reads "Could not open".
- Cost if wrong: a dead deliverable link still shows as a link. Its label is "Stated by a person" either way.

**E5. Pure, then read.**
- `buildEvidenceChain` (`src/lib/evidence-chain.ts`) is pure: it takes the record, its counterparty, the ledger
  entries, the screening check, the payment, the receipt, the members' emails and the results of the checks, and
  returns the steps, a tally of labels and the entries. Unit tests hold it to E2 and E3.
- `readEvidence` (`src/lib/evidence-read.ts`) reads through the DAL inside the organization scope: the record and its
  counterparty, `ledger_entries_for_targets`, the verdict entries (`decision_verdict` names the payable as
  `subjectId`), the counterparty's compliance entries (address set and confirmed, purchase orders, dismissed matches),
  the newest complete screening check at or before the paying decision, the payment intent, the receipt and its
  entries, and the members. Then it runs the checks (E4) and calls the builder.
- No migration, no write, no ledger entry. Tenant isolation is the DAL's: every read is `db()`.

**E6. Entry points.**
- On AP / AR and Contractors, every payable's and milestone's card footer links **Why it was paid** (a paid one) or
  **Evidence so far** (an open one).
- At the foot of the decision trail: **The whole chain, from purchase order to receipt**.
- The page's decision step links back to the trail (`/invoices?history=all#trail-<id>`), and each entry to its place in
  the audit log.

**E7. Download the evidence.**
- `GET /api/evidence?org=<slug>&kind=invoice|milestone&id=<id>` answers a JSON file,
  `vestiarion-evidence/1`: the workspace, the subject, every step with its facts and labels, every entry in full (the
  fields the audit export carries, so each can be checked alone: body hash, signature, and its chain hash from its
  `prev_hash`), the server's check of each, and the workspace's public keys.
- Same gate as the audit export: a session, membership (404 otherwise, never saying whether a workspace exists), and a
  cross-site request refused.
- Not recorded in the ledger: it is a read of one payment's evidence every member can already see. The whole-ledger
  export records itself because it carries everything. Cost if wrong: no trace of who took one payment's evidence out.
- No printable page in this version: the page prints from the browser. Cost if wrong: the navigation prints too.

**E8. People are named by email.** As Approvals names approvers: the member's email when they are still a member, "a
former member" otherwise, "the payee" for an address sent through a payee link or GitHub. The download carries the
same, so an accountant can say who. Ledger entries themselves keep user ids only, as before.

**E9. Product copy.** The network's own label ("Arc testnet", "Arc mainnet"). A payment on Arc testnet is never
called the business's bank paying; in shadow mode the payment step says it mirrors a bill the business paid its own
way.

## Testing

- The builder: a payable paid with full evidence; paid with no purchase order; a milestone with GitHub evidence; a
  delivery a person stated; an unreachable link (Arc did not answer, a revoked receipt, GitHub unavailable); an open
  bill; labels never upgraded (a signed entry leaves a stated fact stated; a step takes its weakest fact).
- The reader: reads only through `db()` in scope, and a receivable or unknown id is not found.
- The route: session, membership 404, cross-site 403, the JSON's shape and file name.
- The page renders on sample data (the guide's screenshot, from `/docs-shots`).

## Rollout

Merge. No migration. Open a paid payable on AP / AR, then **Why it was paid**.
