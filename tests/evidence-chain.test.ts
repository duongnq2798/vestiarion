import { describe, expect, it } from "vitest";
import {
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
    expect(chain.subject).toMatchObject({ kind: "invoice", id: INVOICE, payee: "Northstar Studio", amount: 12.5, currency: "USDC", paid: true });
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
