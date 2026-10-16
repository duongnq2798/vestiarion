import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/bank-payouts", () => ({ startBankPayoutsAction: vi.fn(), setBankAccountAction: vi.fn(), stopBankAccountAction: vi.fn(), mintTestUsdbAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({ approveInvoiceAction: vi.fn(), rejectInvoiceAction: vi.fn(), returnInvoiceAction: vi.fn(), addInvoiceDetailsAction: vi.fn() }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import ApprovalCard, { payConfirmTitle } from "@/components/ApprovalCard";
import BankPayoutsPanel, { BANK_PAYOUTS_NOTICES } from "@/components/BankPayoutsPanel";
import CounterpartyBankAccount from "@/components/intake/CounterpartyBankAccount";
import type { WaitingPayable } from "@/lib/agent/approvals";

/**
 * Bank payouts in the console (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4, B12): the Settings card
 * an owner sets them up from, a vendor's bank account on Counterparties shown by its bank and last four only, and the
 * approval card saying where the money goes and what the vendor receives in pesos.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

describe("BankPayoutsPanel (B3)", () => {
  const panel = (view: Parameters<typeof BankPayoutsPanel>[0]["view"], canSetUp = true, notice: string | null = null) =>
    decode(renderToStaticMarkup(<BankPayoutsPanel orgSlug="pinecrest" view={view} canSetUp={canSetUp} notice={notice} />));

  it("sets up through BlindPay's terms, for an owner only", () => {
    expect(panel({ state: "not_started" })).toContain("Accept BlindPay's terms and set up");
    expect(panel({ state: "not_started" }, false)).toContain("An owner sets up bank payouts.");
    expect(panel({ state: "not_started" }, false)).not.toContain("Accept BlindPay's terms");
    expect(panel({ state: "not_set_up" })).toContain("Bank payouts are not set up on this deployment yet.");
    expect(panel({ state: "not_started" })).toContain('href="/docs/guides/bank-payouts"');
  });

  it("says how the workspace stands with BlindPay, and what BlindPay's way back said", () => {
    const markup = panel({ state: "set_up", kybStatus: "approved", setUpAt: "2026-10-16T08:00:00Z", vendors: 1 }, true, "set_up");
    expect(markup).toContain("Approved by BlindPay.");
    expect(markup).toContain("1 vendor is paid to a bank account.");
    expect(markup).toContain(BANK_PAYOUTS_NOTICES.set_up.text);
    expect(markup).toContain("no pesos reach a bank");
  });
});

describe("test USDB on the Bank payouts card (B13)", () => {
  const setUp = (testToken: { balance: number | null } | null, canMint = true) =>
    decode(
      renderToStaticMarkup(
        <BankPayoutsPanel orgSlug="pinecrest" view={{ state: "set_up", kybStatus: "approved", setUpAt: null, vendors: 0, testToken }} canSetUp canMint={canMint} notice={null} />
      )
    );

  it("mints it for an owner or admin on Arc testnet, saying what the wallet holds", () => {
    expect(setUp({ balance: 12.5 })).toContain("The operating wallet holds 12.5 test USDB.");
    expect(setUp({ balance: 12.5 })).toContain("Mint 100 test USDB");
    expect(setUp({ balance: null })).toContain("Its USDB could not be read just now.");
    expect(setUp({ balance: 0 }, false)).not.toContain("Mint 100 test USDB");
    expect(setUp(null)).not.toContain("test USDB");
  });
});

describe("CounterpartyBankAccount (B4)", () => {
  const ACCOUNT = { bankCode: "012", last4: "9716", beneficiaryName: "Ana López", status: "approved" };
  const view = (props: Partial<Parameters<typeof CounterpartyBankAccount>[0]> = {}) =>
    decode(
      renderToStaticMarkup(
        <CounterpartyBankAccount orgSlug="pinecrest" counterparty={{ id: "cp-1", name: "Taller Norte" }} account={ACCOUNT} canManage setUp {...props} />
      )
    );

  it("shows the account by its bank and last four, never the CLABE", () => {
    const markup = view();
    expect(markup).toContain("Paid to BBVA ····9716, Ana López, through BlindPay.");
    expect(markup).not.toMatch(/\d{18}/);
    expect(markup).toContain("Replace");
    expect(markup).toContain("Remove");
    expect(view({ account: { ...ACCOUNT, status: "verifying" } })).toContain("BlindPay is checking it.");
  });

  it("is added only by an owner or admin of a workspace set up with BlindPay", () => {
    expect(view({ account: null })).toContain("None: paid to its address.");
    expect(view({ account: null })).toContain(">Add<");
    expect(view({ account: null, canManage: false })).not.toContain(">Add<");
    expect(view({ account: null, setUp: false })).toContain("Set up bank payouts under Settings to pay it in pesos.");
  });
});

describe("the approval card of a bank payout (B12)", () => {
  const BANK: NonNullable<WaitingPayable["bank"]> = {
    bankCode: "012",
    last4: "9716",
    beneficiaryName: "Ana López",
    accountStatus: "approved",
    quote: { receiverAmount: 1814, currency: "MXN", rate: 18.35, feesReceiver: 2.1 },
    quoteProblem: null,
  };
  const payable: WaitingPayable = {
    id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1",
    counterpartyId: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1",
    counterpartyName: "Taller Norte",
    riskLevel: "low",
    amount: 100,
    dueDate: "2026-10-20",
    status: "held",
    reasoning: "A person approves every bank payout.",
    explanation: "A person approves every bank payout.",
    decidedAt: "2026-10-16T08:00:00.000+00:00",
    createdBy: null,
    reviewedAt: null,
    reclaimable: false,
    paymentSent: false,
    address: null,
    lastAttempt: null,
    discount: null,
    currency: "USDC",
    payeeChain: "ARC-TESTNET",
    bridgeFeeUsdc: null,
    poReference: null,
    goodsReceived: false,
    addedSinceDecision: null,
    guardrailRule: "payout.bank_needs_person",
    bank: BANK,
  };

  it("says where the money goes and what the vendor receives, instead of an address", () => {
    const markup = decode(
      renderToStaticMarkup(<ApprovalCard orgSlug="pinecrest" payable={payable} canDecide canEdit={false} viewerId="0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5" sandbox={false} soleApprover={false} />)
    );
    expect(markup).toContain("Paid to a bank account in Mexico: BBVA ····9716, Ana López, through BlindPay.");
    expect(markup).toContain("Ana López receives about 1,814.00 MXN");
    expect(markup).not.toContain("no address set");
  });

  it("asks to pay the USDC to the vendor's bank account, with what it receives", () => {
    expect(payConfirmTitle(payable, false)).toBe(
      "Pay 100.00 USDC to Taller Norte's bank account in Mexico now? Ana López receives about 1,814.00 MXN (18.35 MXN per USDC, BlindPay's fees 2.10 MXN). Approve and pay asks BlindPay for a fresh quote."
    );
  });
});
