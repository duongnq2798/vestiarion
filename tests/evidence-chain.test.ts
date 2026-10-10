import { describe, expect, it } from "vitest";
import {
  buildEvidenceChain,
  EVIDENCE_ORDER,
  EVIDENCE_WORDS,
  SIGNED_ENTRY_PROVES,
  weakest,
  type EvidenceChain,
  type EvidenceEntry,
  type EvidenceInput,
  type EvidenceKind,
  type EvidenceStep,
} from "@/lib/evidence-chain";
import { txUrl } from "@/lib/payee-chains";
import type { EntryCheck } from "@/lib/receipts/verify";

/**
 * Why it was paid (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E2, E3): one chain per payment, each
 * fact labelled by how it is known, and no label ever above where the fact came from.
 */

const INVOICE = "5f1e2d3c-0000-4000-8000-000000000001";
const MILESTONE = "5f1e2d3c-0000-4000-8000-000000000002";
const CP = "5f1e2d3c-0000-4000-8000-0000000000cc";
const ALICE = "u-alice";
const BOB = "u-bob";
const CAROL = "u-carol";
const PEOPLE = new Map([
  [ALICE, "alice@northstar.test"],
  [BOB, "bob@northstar.test"],
  [CAROL, "carol@northstar.test"],
]);
const PAYEE = "0x221B000000000000000000000000000000001bc3";
const TX = `0x${"79".repeat(32)}`;
const PR = "https://github.com/acme/app/pull/12";
const at = (time: string) => `2026-10-05T${time}Z`;

function entry(seq: number, time: string, actor: string, action: string, detail: Record<string, unknown>, domain = "ap"): EvidenceEntry {
  return {
    seq,
    ts: at(time),
    actor,
    domain,
    action,
    summary: action,
    detail,
    body_hash: "b".repeat(64),
    signature: "5".repeat(128),
    prev_hash: "0".repeat(64),
    hash: String(seq).padStart(64, "a"),
    signing_key_id: "k1",
  };
}

const ADDRESS_GIVEN = entry(10, "08:00:00", "human", "create_counterparty", { by: ALICE, counterpartyId: CP, address: PAYEE }, "compliance");
const ADDRESS_CONFIRMED = entry(11, "08:05:00", "human", "counterparty_address_confirmed", { by: BOB, counterpartyId: CP, address: PAYEE }, "compliance");

const PAY_OBSERVED = {
  amount: 12.5,
  paymentLimit: 50,
  riskLevel: "clear",
  poReference: "PO-2207",
  goodsReceived: true,
  purchaseOrderRequired: true,
  duplicateCheck: { matchesTotal: 0 },
};

const AGENT_PAID = entry(22, "10:02:40", "agent", "ap_pay", {
  invoiceId: INVOICE,
  counterpartyId: CP,
  decision: { action: "pay" },
  decisionMode: "deepseek",
  agreedWithReference: true,
  guardrailBlocked: false,
  observed: PAY_OBSERVED,
  onChainLimit: { verdict: { state: "allowed" } },
  execution: { txRef: TX, resultingStatus: "paid" },
});

const SHARED = entry(30, "11:00:00", "human", "receipt_shared", { receipt: { txHash: TX }, records: { seq: 22, hash: AGENT_PAID.hash } });

function okChecks(entries: readonly EvidenceEntry[]): Map<number, EntryCheck> {
  return new Map(entries.map((row) => [row.seq, { ok: true } as EntryCheck]));
}

/** A payable paid by the agent with every link there: purchase order and goods stated, Arc's record, a shared receipt. */
function paidInFull(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  const entries = [
    ADDRESS_GIVEN,
    ADDRESS_CONFIRMED,
    entry(20, "09:30:00", "human", "create_invoice", {
      by: ALICE,
      invoiceId: INVOICE,
      counterpartyId: CP,
      amount: 12.5,
      currency: "USDC",
      dueDate: "2026-10-15",
      poReference: "PO-2207",
      goodsReceived: false,
      document: { kind: "pdf", sha256: "ab".repeat(32), reader: "deepseek", changed: [] },
    }),
    entry(21, "10:01:00", "human", "invoice_details_added", { by: BOB, invoiceId: INVOICE, counterpartyId: CP, added: { goodsReceived: true } }),
    AGENT_PAID,
    SHARED,
  ];
  return {
    network: "arc-testnet",
    subject: {
      kind: "invoice",
      invoice: {
        id: INVOICE,
        direction: "payable",
        counterparty_id: CP,
        amount: 12.5,
        currency: "USDC",
        memo: "October design retainer",
        po_reference: "PO-2207",
        goods_received: true,
        due_date: "2026-10-15T00:00:00Z",
        status: "paid",
        tx_ref: TX,
      },
    },
    counterparty: { id: CP, name: "Northstar Studio", address: PAYEE, chain: "ARC-TESTNET", risk_level: "clear", purchase_order_required: true, sample: false },
    entries,
    screening: { risk_level: "clear", source: "opensanctions:yente", screening_mode: "live", created_at: at("09:00:00") },
    payment: {
      status: "confirmed",
      provider: "circle",
      provider_mode: "live",
      token: "USDC",
      amount: "12.500000",
      destination: PAYEE,
      tx_hash: TX,
      chain: "ARC-TESTNET",
      destination_chain: null,
      mint_tx_hash: null,
      bridge_fee: null,
      payout_route: null,
      confirmed_at: at("10:03:00"),
      network: "arc-testnet",
    },
    receipt: { entry_seq: 30, created_at: at("11:00:00"), revoked_at: null, created_by: ALICE },
    people: PEOPLE,
    checks: { entries: okChecks(entries), onChain: { state: "matches", block: 4_210_331 } },
    ...overrides,
  };
}

const step = (chain: EvidenceChain, id: EvidenceStep["id"]): EvidenceStep => {
  const found = chain.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no ${id} step`);
  return found;
};
const kinds = (s: EvidenceStep) => s.facts.map((fact) => fact.kind);

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
    const revoked = entry(31, "12:00:00", "human", "receipt_revoked", { by: ALICE, receiptId: "r1" });
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
