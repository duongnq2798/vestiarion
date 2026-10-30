import { describe, expect, it } from "vitest";
import {
  givenLinks,
  buildEvidenceChain,
  chainAnchors,
  EVIDENCE_MEANINGS,
  EVIDENCE_ORDER,
  EVIDENCE_WORDS,
  SIGNED_ENTRY_PROVES,
  weakest,
  type EvidenceEntry,
  type EvidenceInput,
  type EvidenceKind,
} from "@/lib/evidence-chain";
import { txUrl } from "@/lib/payee-chains";
import {
  ADDRESS_CONFIRMED,
  ADDRESS_GIVEN,
  AGENT_PAID,
  ALICE,
  at,
  BOB,
  CAROL,
  CP,
  entry,
  INVOICE,
  kinds,
  MILESTONE,
  okChecks,
  paidInFull,
  PAY_OBSERVED,
  PAYEE,
  PR,
  step,
  TX,
} from "./support/evidence-fixtures";

/**
 * Why it was paid (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E2, E3): one chain per payment, each
 * fact labelled by how it is known, and no label ever above where the fact came from.
 */

describe("how a fact is known", () => {
  it("has seven words: five ways of knowing and two outcomes of a check", () => {
    expect(EVIDENCE_WORDS).toEqual({
      checked: "Checked by code",
      verified: "Verified outside",
      stated: "Stated by a person",
      inferred: "Inferred",
      missing: "Missing",
      unreachable: "Could not open",
      contradicted: "Does not match",
    });
  });

  it("orders them weakest first, and a step reads as its weakest fact", () => {
    expect(EVIDENCE_ORDER).toEqual(["contradicted", "unreachable", "missing", "inferred", "stated", "checked", "verified"]);
    expect(weakest(["verified", "stated", "checked"])).toBe("stated");
    expect(weakest(["verified", "unreachable"])).toBe("unreachable");
    expect(weakest(["checked", "verified"])).toBe("checked");
    expect(weakest([])).toBe("missing");
  });

  it("explains each word once, in a line that never upgrades a check that got no answer", () => {
    expect(Object.keys(EVIDENCE_MEANINGS).sort()).toEqual(Object.keys(EVIDENCE_WORDS).sort());
    for (const meaning of Object.values(EVIDENCE_MEANINGS)) expect(meaning).toMatch(/^[A-Z].*\.$/);
    expect(EVIDENCE_MEANINGS.unreachable).toContain("never counts as verified");
    expect(EVIDENCE_MEANINGS.stated).toContain("who, and when");
  });
});

describe("a payable paid with full evidence", () => {
  const chain = buildEvidenceChain(paidInFull());

  it("chains the nine links in order", () => {
    expect(chain.steps.map((s) => s.id)).toEqual(["agreed", "delivered", "bill", "payee", "decision", "people", "payment", "receipt", "signatures"]);
    expect(chain.subject).toMatchObject({ kind: "invoice", id: INVOICE, payee: "Northstar Studio", amount: 12.5, currency: "USDC", paid: true, onChain: true });
  });

  it("says who stated the purchase order and the goods, and when", () => {
    const agreed = step(chain, "agreed");
    expect(agreed.kind).toBe("stated");
    expect(agreed.facts[0]).toMatchObject({ kind: "stated", who: "alice@northstar.test", at: at("09:30:00"), seqs: [20] });
    expect(agreed.facts[0].text).toContain("PO-2207");
    const delivered = step(chain, "delivered");
    expect(delivered.kind).toBe("stated");
    expect(delivered.facts[0]).toMatchObject({ kind: "stated", who: "bob@northstar.test", at: at("10:01:00"), seqs: [21] });
  });

  it("says where the bill came from", () => {
    const bill = step(chain, "bill");
    expect(bill.kind).toBe("stated");
    expect(bill.facts[0]).toMatchObject({ kind: "stated", who: "alice@northstar.test", seqs: [20] });
    expect(bill.facts[0].text).toMatch(/read from a PDF/);
  });

  it("names who gave and confirmed the address, and the screening service that cleared the payee", () => {
    const payee = step(chain, "payee");
    expect(payee.facts.map((fact) => [fact.kind, fact.who ?? null])).toEqual([
      ["stated", "alice@northstar.test"],
      ["stated", "bob@northstar.test"],
      ["verified", null],
    ]);
    expect(payee.facts[2].text).toMatch(/OpenSanctions/);
    expect(payee.kind).toBe("stated");
  });

  it("links the decision into its trail, with the model's judgement inferred and code's checks checked", () => {
    const decision = step(chain, "decision");
    expect(decision.trail).toEqual({ invoiceId: INVOICE });
    expect(decision.facts[0]).toMatchObject({ kind: "inferred", text: "DeepSeek decided to pay it, as the written policy would.", seqs: [22] });
    expect(decision.facts[1].kind).toBe("checked");
    expect(decision.facts[1].notes).toContain("✓ Purchase order PO-2207 on file and the goods received");
    expect(decision.facts[1].notes).toContain("✓ The spending-limit contract on Arc allowed it");
    expect(decision.kind).toBe("inferred");
  });

  it("says no person approved it, because code let the agent pay it", () => {
    const people = step(chain, "people");
    expect(people.facts).toHaveLength(1);
    expect(people.facts[0].kind).toBe("checked");
    expect(people.facts[0].text).toMatch(/No person approved it/);
  });

  it("verifies the payment against Arc's own record, and names the entry that records it", () => {
    const payment = step(chain, "payment");
    expect(payment.facts[0].kind).toBe("verified");
    expect(payment.facts[0].link).toMatchObject({ href: txUrl("arc-testnet", TX), state: "checked" });
    expect(payment.facts[0].notes?.join(" ")).toMatch(/Block 4210331/);
    expect(payment.facts[1]).toMatchObject({ kind: "checked", seqs: [22] });
  });

  it("checks the shared receipt: its entry verifies and names the entry that records the transaction", () => {
    const receipt = step(chain, "receipt");
    expect(receipt.kind).toBe("checked");
    expect(receipt.facts[0]).toMatchObject({ kind: "checked", who: "alice@northstar.test", seqs: [30, 22] });
  });

  it("lists every entry with its check, and says in one plain line what a signature proves", () => {
    const signatures = step(chain, "signatures");
    expect(signatures.kind).toBe("checked");
    expect(signatures.caveat).toBe(SIGNED_ENTRY_PROVES);
    expect(SIGNED_ENTRY_PROVES).toBe("A signed entry proves who recorded what, and when. It does not prove the goods were good or the work was done.");
    expect(chain.entries.map((row) => row.seq)).toEqual([10, 11, 20, 21, 22, 30]);
    expect(chain.entries.every((row) => row.check.ok === true)).toBe(true);
  });

  it("tallies the facts by how they are known", () => {
    const all = chain.steps.flatMap((s) => s.facts.map((fact) => fact.kind));
    for (const kind of Object.keys(chain.tally) as EvidenceKind[]) expect(chain.tally[kind]).toBe(all.filter((k) => k === kind).length);
  });
});

describe("labels are never upgraded", () => {
  it("leaves goods a person marked received stated, though its entry is signed and verifies", () => {
    const chain = buildEvidenceChain(paidInFull());
    const delivered = step(chain, "delivered");
    expect(chain.entries.find((row) => row.seq === 21)?.check).toEqual({ ok: true });
    expect(kinds(delivered)).toEqual(["stated"]);
    expect(delivered.kind).toBe("stated");
  });

  it("leaves a purchase order no entry names stated, never inferred up to checked", () => {
    const input = paidInFull();
    const chain = buildEvidenceChain({ ...input, entries: input.entries.filter((row) => row.seq !== 20) });
    expect(step(chain, "agreed").facts[0]).toMatchObject({ kind: "stated", who: null });
  });

  it("never reads a step above its weakest fact", () => {
    const chain = buildEvidenceChain(paidInFull());
    const rank = (kind: EvidenceKind) => EVIDENCE_ORDER.indexOf(kind);
    for (const s of chain.steps) expect(rank(s.kind)).toBe(Math.min(...s.facts.map((fact) => rank(fact.kind))));
  });
});

describe("a payable paid with no purchase order", () => {
  const entries = [
    ADDRESS_GIVEN,
    ADDRESS_CONFIRMED,
    entry(40, "09:00:00", "human", "create_invoice", { by: ALICE, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", poReference: null, goodsReceived: true }),
    entry(41, "09:00:30", "agent", "ap_request_info", {
      invoiceId: INVOICE,
      decision: { action: "request_info" },
      decisionMode: "deepseek",
      agreedWithReference: true,
      guardrailBlocked: false,
      observed: { ...PAY_OBSERVED, poReference: null },
      execution: { resultingStatus: "awaiting_info" },
    }),
    entry(42, "12:00:00", "human", "approval_paid", { by: CAROL, invoiceId: INVOICE, counterpartyId: CP, txRef: TX, status: "paid" }),
  ];
  const base = paidInFull();
  const chain = buildEvidenceChain({
    ...base,
    subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, po_reference: null } as never },
    entries,
    receipt: null,
    checks: { entries: okChecks(entries), onChain: { state: "matches", block: 9 } },
  });

  it("shows the purchase order as missing, with what would fill it", () => {
    const agreed = step(chain, "agreed");
    expect(agreed.kind).toBe("missing");
    expect(agreed.facts[0].text).toBe("No purchase order is on file.");
    expect(agreed.facts[0].fill).toMatch(/purchase order/);
  });

  it("shows the agent's last decision, and the person who paid it instead", () => {
    expect(step(chain, "decision").facts[0].text).toBe("DeepSeek decided to ask for more information before paying it, as the written policy would.");
    const people = step(chain, "people");
    expect(people.facts[0]).toMatchObject({ kind: "stated", who: "carol@northstar.test", at: at("12:00:00"), seqs: [42] });
    expect(people.facts[0].text).toMatch(/Approved and paid/);
  });

  it("names the approval as the entry that records the transaction", () => {
    expect(step(chain, "payment").facts[1]).toMatchObject({ kind: "checked", seqs: [42] });
  });

  it("says the receipt was not shared, and how to share it", () => {
    const receipt = step(chain, "receipt");
    expect(receipt.kind).toBe("missing");
    expect(receipt.facts[0].fill).toMatch(/Share receipt/);
  });
});

describe("a link that cannot be opened", () => {
  it("reads Could not open when Arc did not answer, never Verified outside", () => {
    const chain = buildEvidenceChain(paidInFull({ checks: { entries: okChecks(paidInFull().entries), onChain: { state: "unreadable" } } }));
    const payment = step(chain, "payment");
    expect(payment.facts[0].kind).toBe("unreachable");
    expect(EVIDENCE_WORDS[payment.facts[0].kind]).toBe("Could not open");
    expect(payment.facts[0].link?.state).toBe("unreachable");
    expect(payment.kind).toBe("unreachable");
    expect(kinds(payment)).not.toContain("verified");
  });

  it("reads Does not match when Arc's record does not hold the transfer", () => {
    const chain = buildEvidenceChain(paidInFull({ checks: { entries: okChecks(paidInFull().entries), onChain: { state: "mismatch", reason: "No transfer of 12.5 USDC to the payee is in this transaction." } } }));
    expect(step(chain, "payment").facts[0]).toMatchObject({ kind: "contradicted", link: expect.objectContaining({ state: "contradicted" }) });
  });

  it("reads Could not open for a receipt whose link was revoked", () => {
    const revoked = entry(31, "12:00:00", "human", "receipt_revoked", { by: ALICE, receiptId: "rcpt-1" });
    const input = paidInFull();
    const chain = buildEvidenceChain({
      ...input,
      entries: [...input.entries, revoked],
      receipt: { ...input.receipt!, revoked_at: at("12:00:00") },
      checks: { ...input.checks, entries: okChecks([...input.entries, revoked]) },
    });
    const receipt = step(chain, "receipt");
    expect(receipt.kind).toBe("unreachable");
    expect(receipt.facts[0].text).toMatch(/revoked/);
  });

  it("reads Does not match for an entry whose signature does not verify, naming it", () => {
    const input = paidInFull();
    const checks = okChecks(input.entries);
    checks.set(21, { ok: false, reason: "The signature does not verify with the workspace's key." });
    const signatures = step(buildEvidenceChain({ ...input, checks: { ...input.checks, entries: checks } }), "signatures");
    expect(signatures.kind).toBe("contradicted");
    expect(signatures.facts.find((fact) => fact.kind === "contradicted")).toMatchObject({ seqs: [21] });
  });
});

describe("an open bill", () => {
  const entries = [ADDRESS_GIVEN, entry(50, "09:00:00", "human", "create_invoice", { by: ALICE, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", poReference: "PO-9", goodsReceived: true })];
  const base = paidInFull();
  const chain = buildEvidenceChain({
    ...base,
    subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "pending", tx_ref: null } as never },
    entries,
    payment: null,
    receipt: null,
    checks: { entries: okChecks(entries), onChain: null },
  });

  it("is read-only and says it is not paid yet", () => {
    expect(chain.subject.paid).toBe(false);
    expect(chain.subject.onChain).toBe(false);
    const payment = step(chain, "payment");
    expect(payment.facts).toEqual([expect.objectContaining({ kind: "missing", text: "Not paid yet." })]);
    expect(payment.facts[0].fill).toMatch(/Arc testnet/);
  });

  it("says the agent has not decided it, and no person has", () => {
    expect(step(chain, "decision").facts[0]).toMatchObject({ kind: "missing", text: "The agent has not decided it yet." });
    expect(step(chain, "people").facts[0].kind).toBe("missing");
    expect(step(chain, "receipt").kind).toBe("missing");
  });
});

describe("sample data", () => {
  const base = paidInFull();
  const chain = buildEvidenceChain({
    ...base,
    subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, tx_ref: "sim_abc" } as never },
    counterparty: { ...base.counterparty!, sample: true, address: null },
    entries: [],
    screening: null,
    payment: null,
    receipt: null,
    checks: { entries: new Map(), onChain: null },
  });

  it("infers the bill from the sample flag, and says a simulated payment moved nothing", () => {
    expect(step(chain, "bill").facts[0]).toMatchObject({ kind: "inferred", text: "Loaded with the sample data; it has no ledger entry of its own." });
    expect(step(chain, "payment").facts[0]).toMatchObject({ kind: "missing", text: "Simulated: nothing moved on chain." });
    expect(step(chain, "signatures").kind).toBe("missing");
  });

  it("offers no way into a decision trail a bill with no entry does not have", () => {
    expect(step(chain, "decision").trail).toBeNull();
  });
});

/** A milestone paid by the agent, its work verified as GitHub reported a merged pull request. */
function milestoneInput(overrides: Partial<{ verification: Record<string, unknown>; entries: EvidenceEntry[] }> = {}): EvidenceInput {
  const entries = overrides.entries ?? [
    ADDRESS_GIVEN,
    ADDRESS_CONFIRMED,
    entry(60, "08:30:00", "human", "create_milestone", { by: ALICE, milestoneId: MILESTONE, counterpartyId: CP, counterpartyName: "Northstar Studio", amount: 25, verificationSource: PR }, "contractor"),
    entry(61, "09:10:00", "system", "verify_milestone_github", { milestoneId: MILESTONE, verificationSource: PR, verificationStatus: "verified", pullRequest: PR, mergedAt: at("09:00:00") }, "contractor"),
    entry(62, "09:11:00", "agent", "milestone_release", {
      milestoneId: MILESTONE,
      counterpartyId: CP,
      decision: { action: "release" },
      decisionMode: "heuristic",
      guardrailBlocked: false,
      observed: { amount: 25, paymentLimit: 100, riskLevel: "clear", verification: { verified: true, method: "github", source: PR, note: null } },
      execution: { txRef: TX, resultingStatus: "paid" },
    }, "contractor"),
  ];
  const base = paidInFull();
  return {
    ...base,
    subject: {
      kind: "milestone",
      milestone: {
        id: MILESTONE,
        contractor_id: CP,
        title: "Fix the login redirect",
        amount: 25,
        status: "paid",
        verified: true,
        verification_method: "github",
        verification_status: "verified",
        verification_source: PR,
        verification_checked_at: at("09:10:00"),
        verified_at: at("09:00:00"),
        verification_detail: { pullRequest: PR, state: "closed", mergedAt: at("09:00:00") },
        tx_ref: TX,
        ...overrides.verification,
      },
    },
    entries,
    payment: { ...base.payment!, amount: "25.000000" },
    receipt: null,
    checks: { entries: okChecks(entries), onChain: { state: "matches", block: 77 } },
  };
}

describe("a milestone with GitHub evidence", () => {
  const chain = buildEvidenceChain(milestoneInput());

  it("has no bill or receipt step: the milestone is its own request to pay", () => {
    expect(chain.steps.map((s) => s.id)).toEqual(["agreed", "delivered", "payee", "decision", "people", "payment", "signatures"]);
    expect(chain.subject).toMatchObject({ kind: "milestone", title: "Fix the login redirect", amount: 25 });
  });

  it("says who added its terms", () => {
    expect(step(chain, "agreed").facts[0]).toMatchObject({ kind: "stated", who: "alice@northstar.test", seqs: [60] });
  });

  it("is verified outside, by GitHub, with the pull request linked", () => {
    const delivered = step(chain, "delivered");
    expect(delivered.kind).toBe("verified");
    expect(delivered.facts[0]).toMatchObject({ kind: "verified", seqs: [61], link: expect.objectContaining({ href: PR, state: "checked" }) });
    expect(delivered.facts[0].text).toMatch(/acme\/app#12/);
  });

  it("names the written policy as code when no model decided", () => {
    const decision = step(chain, "decision");
    expect(decision.facts[0]).toMatchObject({ kind: "checked", text: "The written policy decided to release it." });
    expect(decision.trail).toBeNull();
  });

  it("verifies the release against Arc's record", () => {
    expect(step(chain, "payment").facts.map((fact) => fact.kind)).toEqual(["verified", "checked"]);
    expect(step(chain, "payment").facts[1].seqs).toEqual([62]);
  });
});

describe("a milestone a person verified", () => {
  const LINK = "https://drive.example.test/handoff";
  const entries = [
    ADDRESS_GIVEN,
    entry(70, "08:30:00", "human", "create_milestone", { by: ALICE, milestoneId: MILESTONE, counterpartyId: CP, amount: 25, verificationSource: LINK }, "contractor"),
    entry(71, "08:31:00", "human", "verify_milestone_manual", { by: BOB, milestoneId: MILESTONE, verificationSource: LINK, verificationMethod: "manual", verified: true }, "contractor"),
  ];

  it("stays stated by that person, and shows the deliverable as a link Vestiarion did not open", () => {
    const chain = buildEvidenceChain(milestoneInput({ entries, verification: { verification_method: "manual", verification_status: "verified", verification_source: LINK, verification_detail: {} } }));
    const delivered = step(chain, "delivered");
    expect(delivered.kind).toBe("stated");
    expect(delivered.facts[0]).toMatchObject({ kind: "stated", who: "bob@northstar.test", seqs: [71], link: expect.objectContaining({ href: LINK, state: "not_opened" }) });
  });
});

describe("a milestone accepted from Linear (Linear acceptance LN8, LN10, LN16)", () => {
  const ISSUE = "https://linear.app/fernhill/issue/ENG-123/billing-export";
  const accepted = entry(81, "08:40:00", "human", "linear_work_accepted", {
    by: BOB, milestoneId: MILESTONE, issueId: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c01", identifier: "ENG-123", issueUrl: ISSUE, completedAt: at("08:30:00"),
    fingerprint: "f".repeat(64), deliverables: [{ kind: "attachment", label: "PR #42", href: "https://github.com/fernhill/app/pull/42" }], criteriaSha256: "c".repeat(64),
  }, "contractor");
  const linear = (verification: Record<string, unknown>, entries: EvidenceEntry[]) =>
    buildEvidenceChain(milestoneInput({ entries: [ADDRESS_GIVEN, ...entries], verification: { verification_method: "linear", verification_source: null, ...verification } }));

  it("shows Linear's word that the issue was done beside the person's acceptance, which is what verifies it", () => {
    const chain = linear({ verification_status: "verified", verified: true, verification_detail: { linearIssue: ISSUE, identifier: "ENG-123", completedAt: at("08:30:00") } }, [accepted]);
    const delivered = step(chain, "delivered");
    expect(delivered.facts[0]).toMatchObject({ kind: "verified", text: "Linear reported the issue done.", link: expect.objectContaining({ href: ISSUE, label: "ENG-123 in Linear", state: "not_opened" }) });
    expect(delivered.facts[1]).toMatchObject({ kind: "stated", who: "bob@northstar.test", seqs: [81] });
    expect(delivered.facts[1].notes).toContain("1 deliverable accepted, by their fingerprint ffffffffffff.");
  });

  it("says an acceptance taken back is missing, with why", () => {
    const withdrawn = entry(82, "08:50:00", "system", "linear_acceptance_withdrawn", { milestoneId: MILESTONE, reason: "canceled", afterPayment: false }, "contractor");
    const chain = linear({ verification_status: "unverified", verified: false, verification_detail: { linearIssue: ISSUE, heldReason: "canceled" } }, [accepted, withdrawn]);
    expect(step(chain, "delivered").facts[0]).toMatchObject({ kind: "missing", text: "The acceptance was taken back before payment: the issue was canceled in Linear.", seqs: [82], warn: true });
  });
});

describe("a given link, labelled by whether it can be opened (evidence access E1, E3)", () => {
  const LINK = "https://drive.example.test/handoff";
  const withLinks = (links: Map<string, { state: "open" } | { state: "cannot_open" | "not_checked" | "no_answer"; reason: string }>, input = milestoneInput()) =>
    buildEvidenceChain({ ...input, checks: { ...input.checks, links } });

  it("marks every link a person or GitHub gave, and none Vestiarion built itself", () => {
    const chain = buildEvidenceChain(milestoneInput());
    expect(givenLinks(chain)).toEqual([PR]);
    expect(step(chain, "payment").facts[0].link?.given).toBeUndefined();
  });

  it("keeps a pull request that opens verified, its link checked", () => {
    const delivered = step(withLinks(new Map([[PR, { state: "open" }]])), "delivered");
    expect(delivered.kind).toBe("verified");
    expect(delivered.facts[0].link).toMatchObject({ state: "checked" });
  });

  it("never counts one that can't be opened as verified, says why, and keeps the step at its weakest", () => {
    const chain = withLinks(new Map([[PR, { state: "cannot_open", reason: "It is in a private repository on GitHub." }]]));
    const delivered = step(chain, "delivered");
    expect(delivered.kind).toBe("unreachable");
    expect(delivered.facts[0]).toMatchObject({ kind: "unreachable", link: { href: PR, state: "cannot_open", reason: "It is in a private repository on GitHub." } });
    expect(delivered.facts[0].notes).toContain("Its link can't be opened, so it is not counted as verified.");
    // Counted once fewer than when it opens: the box of labels never counts it verified.
    expect(chain.tally.verified).toBe(withLinks(new Map([[PR, { state: "open" }]])).tally.verified - 1);
  });

  it("reads a check with no answer, or no check at all, as not verified either", () => {
    expect(step(withLinks(new Map([[PR, { state: "no_answer", reason: "GitHub did not answer just now." }]])), "delivered").facts[0]).toMatchObject({
      kind: "unreachable",
      link: { state: "unreachable", reason: "GitHub did not answer just now." },
    });
    expect(step(withLinks(new Map()), "delivered").facts[0]).toMatchObject({ kind: "unreachable", link: { state: "not_opened" } });
  });

  it("keeps what a person stated as stated, and its link not checked, or can't be opened, as it is", () => {
    const entries = [
      ADDRESS_GIVEN,
      entry(71, "08:31:00", "human", "verify_milestone_manual", { by: BOB, milestoneId: MILESTONE, verificationSource: LINK, verificationMethod: "manual", verified: true }, "contractor"),
    ];
    const input = milestoneInput({ entries, verification: { verification_method: "manual", verification_status: "verified", verification_source: LINK, verification_detail: {} } });
    const notChecked = step(withLinks(new Map([[LINK, { state: "not_checked", reason: "Vestiarion checks links on GitHub and on its own file storage only, and never opens other sites." }]]), input), "delivered");
    expect(notChecked.facts[0]).toMatchObject({ kind: "stated", link: { state: "not_opened", reason: expect.stringContaining("never opens other sites") } });
    const gone = step(withLinks(new Map([[LINK, { state: "cannot_open", reason: "The signed link expired on 2026-10-12 08:30 UTC." }]]), input), "delivered");
    expect(gone.facts[0]).toMatchObject({ kind: "stated", link: { state: "cannot_open" } });
  });
});

describe("the page's name for where bills live (workspace shell design S2)", () => {
  it("never says AP / AR: a fill names Bills & receivables", () => {
    const base = paidInFull();
    const open = buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "held", tx_ref: null, po_reference: null, goods_received: false } as never },
      counterparty: { ...base.counterparty!, purchase_order_required: true },
      entries: [ADDRESS_GIVEN],
      payment: null,
      receipt: null,
      checks: { entries: okChecks([ADDRESS_GIVEN]), onChain: null },
    });
    const words = JSON.stringify(open.steps);
    expect(words).not.toContain("AP / AR");
    expect(step(open, "delivered").facts[0].fill).toBe("A person marks them received with Add details on Bills & receivables.");
    expect(step(open, "agreed").facts[0].fill).toMatch(/Add details on Bills & receivables/);
    expect(JSON.stringify(buildEvidenceChain(paidInFull({ receipt: null })).steps)).toContain("Share receipt on Bills & receivables");
  });
});

describe("a first of two approvals", () => {
  it("is a person's fact, before the second approval that paid it", () => {
    const input = paidInFull();
    const first = entry(23, "10:30:00", "human", "approval_given", { by: BOB, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", twoApprovalsAbove: 10 });
    const second = entry(24, "10:40:00", "human", "approval_paid", {
      by: CAROL,
      invoiceId: INVOICE,
      counterpartyId: CP,
      txRef: TX,
      status: "paid",
      approvals: [{ by: BOB, at: at("10:30:00") }, { by: CAROL, at: at("10:40:00") }],
    });
    const held = entry(22, "10:02:40", "agent", "ap_hold", { ...AGENT_PAID.detail, decision: { action: "hold" }, execution: { resultingStatus: "held" } });
    const entries = [...input.entries.filter((row) => row.seq !== 22 && row.seq !== 30), held, first, second];
    const chain = buildEvidenceChain({ ...input, entries, receipt: null, checks: { ...input.checks, entries: okChecks(entries) } });
    const people = step(chain, "people");
    expect(people.facts.map((fact) => [fact.text, fact.who])).toEqual([
      ["Gave the first of two approvals.", "bob@northstar.test"],
      ["Approved and paid it.", "carol@northstar.test"],
    ]);
    expect(people.facts[1].notes).toEqual(["Approved by bob@northstar.test on Oct 5, 2026, 10:30 UTC", "Approved by carol@northstar.test on Oct 5, 2026, 10:40 UTC"]);
    expect(step(chain, "payment").facts[1].seqs).toEqual([24]);
  });
});

describe("a person's approval, by what its transfer did (settlement lifecycle L9)", () => {
  const peopleSays = (action: "approval_paid" | "milestone_approval_paid", detail: Record<string, unknown>, network: "arc-testnet" | "arc-mainnet" = "arc-testnet") => {
    const input = action === "approval_paid" ? paidInFull() : milestoneInput();
    const target = action === "approval_paid" ? { invoiceId: INVOICE } : { milestoneId: MILESTONE };
    const approval = entry(42, "12:00:00", "human", action, { by: CAROL, counterpartyId: CP, txRef: TX, ...target, ...detail }, action === "approval_paid" ? "ap" : "contractor");
    const entries = [...input.entries, approval];
    const chain = buildEvidenceChain({ ...input, network, entries, receipt: null, checks: { ...input.checks, entries: okChecks(entries) } });
    return step(chain, "people").facts.find((fact) => fact.seqs.includes(42))?.text;
  };

  it("says paid only once the transfer confirmed", () => {
    expect(peopleSays("approval_paid", { status: "paid" })).toBe("Approved and paid it.");
    expect(peopleSays("approval_paid", { status: "paid", soleApprover: true })).toBe("Approved and paid it, as the workspace's only approver.");
  });

  it("says a payment only submitted waits for Circle to confirm it, on the workspace's network (I17)", () => {
    expect(peopleSays("approval_paid", { status: "matched" })).toBe("Approved it; the payment was submitted and is waiting for Circle to confirm it on Arc testnet.");
    expect(peopleSays("approval_paid", { status: "matched" }, "arc-mainnet")).toBe("Approved it; the payment was submitted and is waiting for Circle to confirm it on Arc mainnet.");
    expect(peopleSays("approval_paid", { status: "matched", via: "slack" })).toBe("Approved it from Slack; the payment was submitted and is waiting for Circle to confirm it on Arc testnet.");
  });

  it("never says failed for a payment held again: Gateway's failure or a failed read may still settle", () => {
    expect(peopleSays("approval_paid", { status: "held" })).toBe("Approved it; the payment was not confirmed, so it was held again.");
    expect(peopleSays("approval_paid", {})).toBe("Approved paying it.");
  });

  it("says the same of a milestone's Pay now, whose transfer in flight leaves it verified", () => {
    expect(peopleSays("milestone_approval_paid", { status: "paid" })).toBe("Approved and paid it with Pay now.");
    expect(peopleSays("milestone_approval_paid", { status: "verified" })).toBe("Approved it with Pay now; the payment was submitted and is waiting for Circle to confirm it on Arc testnet.");
    expect(peopleSays("milestone_approval_paid", { status: "held" })).toBe("Approved it with Pay now; the payment was not confirmed, so it was held again.");
  });
});

describe("a shared receipt, checked as its public page checks it", () => {
  const RECEIPT_ID = "rcpt-1";

  it("finds the entry that revoked its link by the receipt, not by the newest revoke in the workspace", () => {
    const input = paidInFull();
    const other = entry(31, "11:30:00", "human", "receipt_revoked", { by: BOB, receiptId: "another-receipt" });
    const own = entry(33, "12:00:00", "human", "receipt_revoked", { by: ALICE, receiptId: RECEIPT_ID });
    const later = entry(35, "13:00:00", "human", "receipt_revoked", { by: BOB, receiptId: "yet-another" });
    const entries = [...input.entries, other, own, later];
    const chain = buildEvidenceChain({
      ...input,
      entries,
      receipt: { ...input.receipt!, id: RECEIPT_ID, revoked_at: at("12:00:00") },
      checks: { ...input.checks, entries: okChecks(entries) },
    });
    expect(step(chain, "receipt").facts[0]).toMatchObject({ kind: "unreachable", seqs: [30, 33] });
  });

  it("does not match when the entry it names has another hash", () => {
    const input = paidInFull();
    const forged = entry(30, "11:00:00", "human", "receipt_shared", { receipt: { txHash: TX }, records: { seq: 22, hash: "f".repeat(64) } });
    const entries = [...input.entries.filter((row) => row.seq !== 30), forged];
    const receipt = step(buildEvidenceChain({ ...input, entries, checks: { ...input.checks, entries: okChecks(entries) } }), "receipt");
    expect(receipt.kind).toBe("contradicted");
    expect(receipt.facts[0].text).toBe("The receipt names an entry that does not record this transaction.");
  });
});

describe("members who could not be read", () => {
  it("names a person as a member, never as a former member", () => {
    const chain = buildEvidenceChain(paidInFull({ people: null }));
    expect(step(chain, "agreed").facts[0].who).toBe("a member");
    expect(JSON.stringify(chain.steps)).not.toContain("a former member");
  });

  it("names someone no longer in the workspace as a former member", () => {
    const chain = buildEvidenceChain(paidInFull({ people: new Map([[BOB, "bob@northstar.test"]]) }));
    expect(step(chain, "agreed").facts[0].who).toBe("a former member");
  });
});

describe("sample data's own facts", () => {
  it("infers a purchase order and goods received that sample data loaded with no entry", () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({ ...base, counterparty: { ...base.counterparty!, sample: true }, entries: [], payment: null, receipt: null, checks: { entries: new Map(), onChain: null } });
    expect(step(chain, "agreed").facts[0]).toMatchObject({ kind: "inferred", text: "Purchase order PO-2207 is on the bill, loaded with the sample data." });
    expect(step(chain, "delivered").facts[0]).toMatchObject({ kind: "inferred", text: "The goods or services are marked received, loaded with the sample data." });
  });

  it("infers a payee's address that sample data loaded with no entry, rather than calling it missing", () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({ ...base, counterparty: { ...base.counterparty!, sample: true }, entries: [], payment: null, receipt: null, checks: { entries: new Map(), onChain: null } });
    expect(step(chain, "payee").facts[0]).toMatchObject({ kind: "inferred", text: "0x221B…1bc3 was loaded with the sample data; no entry names who gave it." });
  });
});

describe("a bill a person rejected", () => {
  it("says it was not paid, with no way to pay it offered", () => {
    const base = paidInFull();
    const rejected = entry(45, "12:00:00", "human", "approval_rejected", { by: CAROL, invoiceId: INVOICE, reason: "Duplicate of an earlier bill" });
    const entries = [ADDRESS_GIVEN, rejected];
    const chain = buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "rejected", tx_ref: null } as never },
      entries,
      payment: null,
      receipt: null,
      checks: { entries: okChecks(entries), onChain: null },
    });
    expect(chain.subject).toMatchObject({ paid: false, closed: true });
    expect(step(chain, "payment").facts).toEqual([expect.objectContaining({ kind: "missing", text: "Not paid: a person rejected it." })]);
    expect(step(chain, "payment").facts[0].fill).toBeUndefined();
    expect(step(chain, "people").facts[0]).toMatchObject({ kind: "stated", text: "Rejected it.", notes: ["Reason: Duplicate of an earlier bill"] });
    expect(step(chain, "receipt").facts[0].fill).toBe("A receipt is made only for a payment on chain.");
  });
});

describe("the anchors a reader asks the screening check for", () => {
  it("names the decision that paid it and the entry that records the payment", () => {
    const anchors = chainAnchors(paidInFull());
    expect(anchors.decision?.seq).toBe(22);
    expect(anchors.recording?.seq).toBe(22);
    expect(anchors.at).toBe(at("10:02:40"));
  });

  it("names the agent's last decision before a person paid it, and the payment's time when the agent never decided", () => {
    const base = paidInFull();
    const paidByPerson = entry(42, "12:00:00", "human", "approval_paid", { by: CAROL, invoiceId: INVOICE, counterpartyId: CP, txRef: TX, status: "paid" });
    expect(chainAnchors({ ...base, entries: [paidByPerson] })).toMatchObject({ decision: null, at: at("12:00:00") });
  });

  it("names no time for an open bill nobody decided: the newest check stands", () => {
    const base = paidInFull();
    expect(chainAnchors({ ...base, entries: [], payment: null, subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "pending", tx_ref: null } as never } }).at).toBeNull();
  });
});

describe("what a signature step says it checked", () => {
  it("says each entry is checked alone, and where the whole chain is checked", () => {
    const signatures = step(buildEvidenceChain(paidInFull()), "signatures");
    expect(signatures.facts[0].text).toBe("6 entries verify: each is signed with the workspace's key, and its hash follows from its content, its signature and the hash before it.");
    expect(signatures.facts[0].notes).toEqual(["The Audit log checks the whole chain, entry after entry."]);
  });
});

describe("a milestone GitHub could not be asked about", () => {
  it("reads Could not open, never verified", () => {
    const chain = buildEvidenceChain(
      milestoneInput({
        verification: { status: "pending", verified: false, verification_status: "unavailable", verification_detail: { pullRequest: PR, error: "GitHub returned HTTP 503" }, tx_ref: null },
      })
    );
    const delivered = step(chain, "delivered");
    expect(delivered.kind).toBe("unreachable");
    expect(delivered.facts[0].link?.state).toBe("unreachable");
    expect(delivered.facts[0].text).toMatch(/GitHub/);
  });
});

describe("a payable paid in shadow mode (E3, E9)", () => {
  // A mirror address Vestiarion made for a payee with none, the agent's decision held for a verdict, a person agreeing
  // with it, and the payment that agreement made through Approve and pay.
  const mirrored = entry(60, "08:00:00", "human", "counterparty_address_changed", { by: ALICE, counterpartyId: CP, via: "mirror", from: null, to: PAYEE }, "compliance");
  const decided = entry(62, "10:00:00", "agent", "ap_pay", {
    invoiceId: INVOICE,
    counterpartyId: CP,
    decision: { action: "pay" },
    decisionMode: "deepseek",
    agreedWithReference: true,
    guardrailBlocked: false,
    shadow: true,
    observed: PAY_OBSERVED,
    execution: { resultingStatus: "held" },
  });
  const verdict = entry(63, "10:30:00", "human", "decision_verdict", { by: BOB, entrySeq: 62, subject: "invoice", subjectId: INVOICE, agentAction: "ap_pay", verdict: "agree", reason: null });
  const paid = entry(64, "10:30:05", "human", "approval_paid", { by: BOB, invoiceId: INVOICE, counterpartyId: CP, txRef: TX, status: "paid" });
  const entries = [
    mirrored,
    entry(61, "09:30:00", "human", "create_invoice", { by: ALICE, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", poReference: "PO-2207", goodsReceived: true }),
    decided,
    verdict,
    paid,
  ];
  const chain = buildEvidenceChain({ ...paidInFull(), entries, receipt: null, checks: { entries: okChecks(entries), onChain: { state: "matches", block: 7 } } });

  it("says code made the payee's mirror address, and no person typed it", () => {
    expect(step(chain, "payee").facts[0]).toMatchObject({
      kind: "checked",
      text: expect.stringContaining("is a mirror address Vestiarion made for Northstar Studio in shadow mode: no person typed it."),
      seqs: [60],
    });
  });

  it("names the person who agreed with the agent's decision, then paid it", () => {
    expect(step(chain, "people").facts).toEqual([
      expect.objectContaining({ kind: "stated", text: "Agreed with the agent's decision.", who: "bob@northstar.test", seqs: [63] }),
      expect.objectContaining({ kind: "stated", text: "Approved and paid it.", who: "bob@northstar.test", seqs: [64] }),
    ]);
  });

  it("says the payment mirrors a bill the business paid its own way, on the network it was made on", () => {
    const payment = step(chain, "payment");
    expect(payment.facts[0].notes).toContain("Made in shadow mode on Arc testnet: it mirrors a bill the business paid its own way.");
    expect(payment.facts[1]).toMatchObject({ kind: "checked", seqs: [64] });
    // The decision the chain rests on is the agent's, before the person's payment.
    expect(step(chain, "decision").facts[0].seqs).toEqual([62]);
  });
});

describe("an address the payee sent through a payee link (independent review, 2026-10-15)", () => {
  // Alice created the link, the payee sent the address through it, and Bob confirmed it.
  const created = entry(12, "08:10:00", "human", "payee_link_created", { by: ALICE, counterpartyId: CP, linkId: "link-1", expiresAt: "2026-10-08T08:10:00Z" }, "compliance");
  const sent = entry(13, "08:20:00", "human", "counterparty_address_changed", { by: null, counterpartyId: CP, via: "payee_link", linkId: "link-1", from: null, to: PAYEE }, "compliance");
  const confirmed = entry(14, "08:30:00", "human", "counterparty_address_confirmed", { by: BOB, counterpartyId: CP, address: PAYEE, via: "confirm" }, "compliance");
  const base = paidInFull();
  const entries = [...base.entries, created, sent, confirmed];
  const chain = buildEvidenceChain({ ...base, entries, checks: { ...base.checks, entries: okChecks(entries) } });

  it("says the payee sent the address, and names who created the link it came through", () => {
    const facts = step(chain, "payee").facts;
    expect(facts[0]).toMatchObject({ kind: "stated", who: "the payee", seqs: [13] });
    expect(facts[0].text).toContain("was sent by the payee through their payee link.");
    expect(facts[1]).toMatchObject({ kind: "stated", text: "The payee link it came through was created.", who: "alice@northstar.test", seqs: [12] });
    expect(facts[2]).toMatchObject({ kind: "stated", who: "bob@northstar.test", seqs: [14] });
  });
});

describe("a workspace on Arc mainnet (E9)", () => {
  it("names its own network in what fills a link, never Arc testnet", () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({
      ...base,
      network: "arc-mainnet",
      subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "pending", tx_ref: null } as never },
      entries: [ADDRESS_GIVEN],
      payment: null,
      receipt: null,
      checks: { entries: okChecks([ADDRESS_GIVEN]), onChain: null },
    });
    expect(step(chain, "payment").facts[0].fill).toBe("Paid on Arc mainnet when the agent or a person pays it.");
    expect(JSON.stringify(chain)).not.toMatch(/testnet/i);
  });
});

describe("a cross-chain payout's shared receipt (CCTP)", () => {
  // Approve and pay on a payee on another chain, the mint landing within the provider's wait: the approval records the
  // burn on Arc, and no entry records the mint. The receipt names that approval, as the public receipt page accepts.
  const MINT = `0x${"8a".repeat(32)}`;
  const base = paidInFull();
  const paid = entry(42, "12:00:00", "human", "approval_paid", { by: CAROL, invoiceId: INVOICE, counterpartyId: CP, txRef: TX, status: "paid" });
  const shared = entry(43, "12:30:00", "human", "receipt_shared", { receipt: { txHash: MINT, sourceTxHash: TX }, records: { seq: 42, hash: paid.hash } });
  const entries = [ADDRESS_GIVEN, ADDRESS_CONFIRMED, base.entries.find((row) => row.seq === 20)!, paid, shared];
  const input: EvidenceInput = {
    ...base,
    entries,
    payment: { ...base.payment!, destination_chain: "BASE-SEPOLIA", mint_tx_hash: MINT },
    receipt: { ...base.receipt!, entry_seq: 43 },
    checks: { entries: okChecks(entries), onChain: { state: "matches", block: 12 } },
  };
  const chain = buildEvidenceChain(input);

  it("checks the receipt against the burn its entry records, as the public receipt page does", () => {
    const receipt = step(chain, "receipt");
    expect(receipt.kind).toBe("checked");
    expect(receipt.facts[0]).toMatchObject({ kind: "checked", seqs: [43, 42] });
    expect(receipt.facts[0].warn).toBeUndefined();
    expect(chain.tally.contradicted).toBe(0);
  });

  it("names the same entry as the one that records the transaction", () => {
    expect(step(chain, "payment").facts[1]).toMatchObject({ kind: "checked", text: "Entry #0042 records this transaction.", seqs: [42] });
  });

  it("still does not match when the entry it names records neither the mint nor the burn", () => {
    const other = entry(42, "12:00:00", "human", "approval_paid", { by: CAROL, invoiceId: INVOICE, counterpartyId: CP, txRef: `0x${"12".repeat(32)}`, status: "paid" });
    const rows = [...entries.filter((row) => row.seq !== 42), other];
    const receipt = step(buildEvidenceChain({ ...input, entries: rows, checks: { ...input.checks, entries: okChecks(rows) } }), "receipt");
    expect(receipt.kind).toBe("contradicted");
  });
});

describe("a payable paid in a simulation", () => {
  it("says so in its subject, which the page's head and the download carry", () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, tx_ref: "sim_abc" } as never },
      payment: { ...base.payment!, provider: "simulated", provider_mode: "simulated", tx_hash: null },
      receipt: null,
      checks: { entries: okChecks(base.entries), onChain: null },
    });
    expect(chain.subject).toMatchObject({ paid: true, simulated: true, onChain: false });
    expect(buildEvidenceChain(paidInFull()).subject.simulated).toBe(false);
  });

  it("is not simulated while it is not paid", () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, status: "matched", tx_ref: null } as never },
      payment: { ...base.payment!, provider: "simulated", provider_mode: "simulated", tx_hash: null },
      receipt: null,
    });
    expect(chain.subject).toMatchObject({ paid: false, simulated: false });
  });
});

describe("a bill written in another currency, in shadow mode (shadow mode S6)", () => {
  const ORIGINAL = { currency: "EUR", amount: 125, perUsd: 0.9246, source: "ExchangeRate-API", at: "2026-10-05T00:00:01Z" };
  const added = entry(20, "09:30:00", "human", "create_invoice", {
    by: ALICE,
    invoiceId: INVOICE,
    counterpartyId: CP,
    amount: 135.19,
    currency: "USDC",
    poReference: "PO-2207",
    goodsReceived: true,
    bill: ORIGINAL,
  });
  const base = paidInFull();
  const entries = [ADDRESS_GIVEN, ADDRESS_CONFIRMED, added];
  const chain = buildEvidenceChain({ ...base, entries, payment: null, receipt: null, checks: { entries: okChecks(entries), onChain: null } });
  const bill = step(chain, "bill");

  it("states the bill's own amount and currency as the person's fact", () => {
    expect(bill.facts[0]).toMatchObject({ kind: "stated", who: "alice@northstar.test", seqs: [20], text: "125 EUR, added in the invoice form on Bills & receivables." });
    expect(bill.facts[0].text).not.toContain("USDC");
  });

  it("says code converted it to USDC at a named rate, its source and its day, never as a person's fact", () => {
    expect(bill.facts[1]).toMatchObject({
      kind: "checked",
      text: "Converted to 135.19 USDC at 0.92 EUR to the US dollar, the rate ExchangeRate-API published on Oct 5, 2026.",
      seqs: [20],
      link: { href: "https://www.exchangerate-api.com", label: "ExchangeRate-API", state: "checked" },
    });
    expect(bill.kind).toBe("stated");
  });

  it("converts a bill in US dollars one for one, naming no rate service", () => {
    const usd = entry(20, "09:30:00", "human", "create_invoice", { ...added.detail, amount: 125, bill: { currency: "USD", amount: 125, perUsd: 1, source: "USD = USDC", at: "2026-10-05T09:30:00Z" } });
    const facts = step(buildEvidenceChain({ ...base, entries: [usd], payment: null, receipt: null, checks: { entries: okChecks([usd]), onChain: null } }), "bill").facts;
    expect(facts.map((fact) => fact.text)).toEqual(["125 USD, added in the invoice form on Bills & receivables.", "Converted to 125.00 USDC at 1 USD = 1 USDC, USDC's 1:1 redemption peg, not a market rate."]);
    expect(facts[1].link).toBeUndefined();
  });
});

describe("a bill imported from a list (import design B12)", () => {
  it("says it was imported, from which row, and keeps the list's hash, not the list", () => {
    const base = paidInFull();
    const imported = entry(20, "09:30:00", "human", "create_invoice", {
      by: ALICE,
      invoiceId: INVOICE,
      counterpartyId: CP,
      amount: 12.5,
      currency: "USDC",
      poReference: "PO-2207",
      goodsReceived: true,
      via: "import",
      importFile: "cd".repeat(32),
      importRow: 4,
    });
    const chain = buildEvidenceChain({ ...base, entries: [imported], payment: null, receipt: null, checks: { entries: okChecks([imported]), onChain: null } });
    expect(step(chain, "bill").facts[0]).toMatchObject({
      kind: "stated",
      text: "12.50 USDC, imported with Import a list on Bills & receivables, from row 4 of the list.",
      notes: [`The list's SHA-256 is ${"cd".repeat(32)}; the list itself is not kept.`],
    });
    expect(step(chain, "agreed").facts[0].text).toBe("Purchase order PO-2207 is on the bill from an imported list.");
    expect(step(chain, "delivered").facts[0].text).toBe("The goods or services are marked received from an imported list.");
  });
});

describe("a bill added from an invoice a payee sent through its payee link (payee invoice link P5)", () => {
  it("says it came from the payee's invoice, added by a person", () => {
    const base = paidInFull();
    const fromPayee = entry(20, "09:30:00", "human", "create_invoice", {
      by: ALICE,
      invoiceId: INVOICE,
      counterpartyId: CP,
      amount: 12.5,
      currency: "USDC",
      poReference: null,
      goodsReceived: true,
      via: "payee_link",
      invoiceDraftId: "7c1d6a52-2f5b-4bb0-9c62-1f1f0d4b9a10",
      invoiceNumber: "INV-7",
      payeeLinkId: "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1",
    });
    const chain = buildEvidenceChain({ ...base, entries: [fromPayee], payment: null, receipt: null, checks: { entries: okChecks([fromPayee]), onChain: null } });
    expect(step(chain, "bill").facts[0]).toMatchObject({ kind: "stated", text: "12.50 USDC, added from an invoice the payee sent through their payee link." });
  });
});

describe("a bill brought in from Xero (Xero connector X11)", () => {
  it("says where it came from, by the number Xero gave it, and who marked its goods received", () => {
    const base = paidInFull();
    const fromXero = entry(20, "09:30:00", "human", "create_invoice", {
      by: ALICE,
      invoiceId: INVOICE,
      counterpartyId: CP,
      amount: 12.5,
      currency: "USDC",
      poReference: null,
      goodsReceived: true,
      via: "xero",
      xero: { tenantId: "tenant-1", billId: "bill-1", contactId: "contact-1", invoiceNumber: "PD-4471" },
    });
    const chain = buildEvidenceChain({ ...base, entries: [fromXero], payment: null, receipt: null, checks: { entries: okChecks([fromXero]), onChain: null } });
    expect(step(chain, "bill").facts[0]).toMatchObject({
      kind: "stated",
      text: "12.50 USDC, brought in from Xero as bill PD-4471, and added on Bills & receivables by the person who reviewed it.",
    });
    expect(step(chain, "delivered").facts[0].text).toBe("The goods or services are marked received in the review of bills from Xero.");
  });
});

describe("a bill brought in from QuickBooks (QuickBooks connector Q16)", () => {
  it("says where it came from, by the number QuickBooks gave it", () => {
    const base = paidInFull();
    const fromQuickBooks = entry(20, "09:30:00", "human", "create_invoice", {
      by: ALICE,
      invoiceId: INVOICE,
      counterpartyId: CP,
      amount: 12.5,
      currency: "USDC",
      poReference: null,
      goodsReceived: true,
      via: "quickbooks",
      quickbooks: { tenantId: "9341455327810551", billId: "146", contactId: "56", invoiceNumber: "PD-4471" },
    });
    const chain = buildEvidenceChain({ ...base, entries: [fromQuickBooks], payment: null, receipt: null, checks: { entries: okChecks([fromQuickBooks]), onChain: null } });
    expect(step(chain, "bill").facts[0]).toMatchObject({
      kind: "stated",
      text: "12.50 USDC, brought in from QuickBooks as bill PD-4471, and added on Bills & receivables by the person who reviewed it.",
    });
    expect(step(chain, "delivered").facts[0].text).toBe("The goods or services are marked received in the review of bills from QuickBooks.");
  });
});

describe("a payable paid with its early-payment discount", () => {
  const base = paidInFull();
  const discounted = entry(22, "10:02:40", "agent", "ap_pay", { ...AGENT_PAID.detail, amountPaid: 12.25, discountTaken: 0.25 });
  const entries = [...base.entries.filter((row) => row.seq !== 22), discounted];
  const input: EvidenceInput = {
    ...base,
    subject: { kind: "invoice", invoice: { ...(base.subject as { invoice: object }).invoice, paid_amount: 12.25 } as never },
    entries,
    payment: { ...base.payment!, amount: "12.250000" },
    checks: { ...base.checks, entries: okChecks(entries) },
  };
  const chain = buildEvidenceChain(input);

  it("carries what was paid beside the bill's amount", () => {
    expect(chain.subject).toMatchObject({ amount: 12.5, paidAmount: 12.25 });
    expect(buildEvidenceChain(paidInFull()).subject.paidAmount).toBeNull();
  });

  it("says what the discount took off the bill, citing the entry that recorded it", () => {
    const payment = step(chain, "payment");
    expect(payment.facts[0].text).toBe("Paid 12.25 USDC to 0x221B…1bc3 on Arc testnet.");
    expect(payment.facts[1]).toMatchObject({ kind: "checked", text: "The early-payment discount took 0.25 USDC off the 12.50 USDC bill, so 12.25 USDC was paid.", at: at("10:02:40"), seqs: [22] });
    expect(payment.facts[2]).toMatchObject({ kind: "checked", text: "Entry #0022 records this transaction." });
  });

  it("reads the discount from the bill's record when no entry records it, as inferred", () => {
    const rows = [...base.entries.filter((row) => row.seq !== 22), AGENT_PAID];
    const payment = step(buildEvidenceChain({ ...input, entries: rows, checks: { ...input.checks, entries: okChecks(rows) } }), "payment");
    expect(payment.facts[1]).toMatchObject({ kind: "inferred", seqs: [] });
    expect(payment.facts[1].text).toBe("The bill's record says 12.25 USDC was paid, 0.25 USDC less than the bill; no entry records the early-payment discount.");
  });

  it("has no paid amount of its own when the whole bill was paid, or it is not paid", () => {
    const invoice = (base.subject as { invoice: object }).invoice;
    expect(buildEvidenceChain({ ...input, subject: { kind: "invoice", invoice: { ...invoice, paid_amount: 12.5 } as never } }).subject.paidAmount).toBeNull();
    const held = buildEvidenceChain({ ...input, subject: { kind: "invoice", invoice: { ...invoice, status: "held", tx_ref: null, paid_amount: 12.25 } as never }, payment: null, receipt: null });
    expect(held.subject.paidAmount).toBeNull();
  });
});

describe("the payment step of a payment whose outcome is not clean (payment exceptions E6)", () => {
  const MAY_HAVE = "Circle did not answer createTransaction within 20000 ms; the transfer may or may not have been accepted";
  const unpaid = (payment: Partial<NonNullable<EvidenceInput["payment"]>>) => {
    const base = paidInFull();
    const invoice = (base.subject as { invoice: object }).invoice;
    return buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...invoice, status: "held", tx_ref: null } as never },
      payment: { ...(base.payment as NonNullable<EvidenceInput["payment"]>), status: "failed", tx_hash: null, confirmed_at: null, ...payment },
      receipt: null,
      checks: { ...base.checks, onChain: null },
    });
  };
  const says = (chain: ReturnType<typeof buildEvidenceChain>) => step(chain, "payment").facts[0];

  it("never calls a send Circle never answered a failure, and says where it is looked for", () => {
    const fact = says(unpaid({ provider_tx_id: null, last_error: MAY_HAVE, provider_state: null }));
    expect(fact.text).toBe("Outcome unknown: Circle did not answer when it was sent, so it may have taken the transfer.");
    expect(fact.fill).toBe("Approve and pay in Approvals looks for it on Circle first and sends nothing twice.");
    expect(fact.warn).toBeUndefined();
  });

  it("leaves an unknown outcome to the agent's next cycle while it comes back to the bill", () => {
    const base = paidInFull();
    const invoice = (base.subject as { invoice: object }).invoice;
    const chain = buildEvidenceChain({
      ...base,
      subject: { kind: "invoice", invoice: { ...invoice, status: "matched", tx_ref: null } as never },
      payment: { ...(base.payment as NonNullable<EvidenceInput["payment"]>), status: "failed", tx_hash: null, confirmed_at: null, provider_tx_id: null, last_error: MAY_HAVE, provider_state: null },
      receipt: null,
      checks: { ...base.checks, onChain: null },
    });
    expect(step(chain, "payment").facts[0].fill).toBe("The agent's next cycle looks for it on Circle first and sends nothing twice.");
  });

  it("keeps a transfer Circle took, whose last read failed, in flight", () => {
    const fact = says(unpaid({ provider_tx_id: "circle-tx-1", last_error: "provider unreachable", provider_state: "SENT" }));
    expect(fact.text).toBe("Sent, not confirmed yet.");
  });

  it("says Gateway's failure may still be minted, and that nothing is sent again", () => {
    const fact = says(unpaid({ provider_tx_id: "gateway:abc", provider_state: "GATEWAY_FAILED" }));
    expect(fact.text).toBe("Gateway reported it failed, but it may still be minted on the payee's chain, so nothing is sent again.");
    expect(fact.fill).toBe("Check with Circle whether it was minted; Approvals shows what to do next.");
  });

  it("names Circle's end and reason for a failure, and where to act", () => {
    const fact = says(unpaid({ provider_tx_id: "circle-tx-1", provider_state: "FAILED", failure_reason: "FAILED_ON_CHAIN" }));
    expect(fact.text).toBe("The transfer failed: Circle ended it (FAILED: FAILED_ON_CHAIN). The payee was not paid.");
    expect(fact.fill).toBe("Approvals shows what to do next.");
    expect(fact.warn).toBe(true);
  });

  it("says a payment that never reached Circle was not sent, with its reason", () => {
    const fact = says(unpaid({ provider_tx_id: null, last_error: "Counterparty has no on-chain address.", provider_state: null }));
    expect(fact.text).toBe("Not sent: it stopped before Circle took the transfer (Counterparty has no on-chain address). The payee was not paid.");
    expect(fact.warn).toBe(true);
  });

  it("keeps the old words for a row read without the columns that tell these apart", () => {
    expect(says(unpaid({})).text).toBe("The transfer failed.");
  });

  it("sends a milestone's person to Contractors, not Approvals", () => {
    const base = paidInFull();
    const chain = buildEvidenceChain({
      ...base,
      subject: { kind: "milestone", milestone: { id: MILESTONE, contractor_id: CP, title: "Fix the login redirect", amount: 12.5, status: "held", tx_ref: null } as never },
      payment: { ...(base.payment as NonNullable<EvidenceInput["payment"]>), status: "failed", tx_hash: null, confirmed_at: null, provider_tx_id: null, last_error: MAY_HAVE, provider_state: null },
      receipt: null,
      checks: { ...base.checks, onChain: null },
    });
    expect(step(chain, "payment").facts[0].fill).toBe("Pay now on Contractors looks for it on Circle first and sends nothing twice.");
  });
});

describe("a purchase order a vendor's document supplied (document checks DK13)", () => {
  it("says the purchase order came from the vendor's document, which the agent checked against the bill", () => {
    const base = paidInFull();
    const created = entry(20, "09:30:00", "human", "create_invoice", { by: ALICE, invoiceId: INVOICE, counterpartyId: CP, amount: 12.5, currency: "USDC", goodsReceived: false });
    const sent = entry(21, "09:40:00", "human", "document_received", { by: null, via: "document_request", invoiceId: INVOICE, counterpartyId: CP, requestId: "r-1", fileSha256: "ef".repeat(32) });
    const checked = entry(22, "09:41:00", "agent", "document_checked", {
      invoiceId: INVOICE,
      counterpartyId: CP,
      requestId: "r-1",
      source: "vendor",
      fileSha256: "ef".repeat(32),
      outcome: "matched",
      poReference: "PO-2207",
      poWritten: true,
    });
    const entries = [created, sent, checked, ...base.entries.filter((row) => row.action !== "create_invoice")];
    const chain = buildEvidenceChain({ ...base, entries, checks: { entries: okChecks(entries), onChain: base.checks.onChain } });
    expect(step(chain, "agreed").facts[0]).toMatchObject({
      kind: "checked",
      text: "Purchase order PO-2207 is on the bill, from the vendor's document, which the agent checked against the bill.",
      at: at("09:41:00"),
      seqs: [22],
    });
  });

  it("says nothing of a check that added no purchase order, or another one", () => {
    const base = paidInFull();
    const shadowCheck = entry(23, "09:41:00", "agent", "document_checked", { invoiceId: INVOICE, outcome: "matched", poReference: "PO-2207", poWritten: false, shadow: true });
    const otherPo = entry(24, "09:42:00", "agent", "document_checked", { invoiceId: INVOICE, outcome: "matched", poReference: "PO-9999", poWritten: true });
    const entries = [...base.entries, shadowCheck, otherPo];
    const chain = buildEvidenceChain({ ...base, entries, checks: { entries: okChecks(entries), onChain: base.checks.onChain } });
    expect(step(chain, "agreed").facts[0]).toMatchObject({ kind: "stated", seqs: [20] });
  });
});
