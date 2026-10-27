/**
 * The recorded team bill the README banner and the GitHub social preview show (/docs-shots/readme-banner): the bill the
 * landing hero reads live (src/components/landing/Hero.tsx, from `landing_team_journeys`), written here as a dated
 * snapshot of the Vestiarion team's own workspace on Arc mainnet, read from production on Oct 27, 2026:
 * - entry #4641, Oct 19, 2026, 10:30:53 UTC, the agent: schedule the 1 USDC bill for Oct 22, as it has no early-payment
 *   discount and paying on its due date keeps the cash free until then; the payout goes to Base over CCTP, with a
 *   0.055114 USDC fee quoted on top. Code held it before anything was sent, `counterparty.new_payee`: the first payment
 *   to a new address.
 * - entry #4643, Oct 19, 2026, 10:31:47 UTC, a person: approved it and it was paid (`approval_paid`), on Base over
 *   CCTP, for a 0.055026 USDC fee.
 * - the payment's confirmation, recorded Oct 19, 2026, 10:31:44 UTC: the burn on Arc mainnet and the mint on Base below.
 * The workspace is named only as the team's, never by its address, and the vendor not at all. A past payment's facts do
 * not change, so they are written here rather than read; the hero may since show a newer bill.
 */
export const README_BANNER_BILL = {
  workspace: "Vestiarion team workspace",
  network: "arc-mainnet",
  amount: 1,
  currency: "USDC",
  status: "paid",
  /** The agent's entry: what it decided, and the same entry is the one code held. */
  check: { seq: 4641, recordedAt: "2026-10-19T10:30:53Z", action: "ap_schedule" },
  decision: { payOn: "2026-10-22", reason: "no_early_payment_discount" },
  hold: { seq: 4641, recordedAt: "2026-10-19T10:30:53Z", action: "ap_schedule" },
  rule: "counterparty.new_payee",
  approval: { seq: 4643, recordedAt: "2026-10-19T10:31:47Z", action: "approval_paid" },
  payment: {
    route: "cctp",
    destination: "BASE",
    /** Quoted at entry #4641. */
    quotedFeeUsdc: 0.055114,
    /** Charged when it was paid, entry #4643. */
    feeUsdc: 0.055026,
    confirmationRecordedAt: "2026-10-19T10:31:44Z",
    burnTxHash: "0x7c3b4b6b2561ca3d3dc0cd15594d7e0e8a9fd6717113e996a14acb243e642a17",
    mintTxHash: "0x9ea0fe5aa1b57f799595a48f336d1e008971e9a1d067dac1707ce02ff656150c",
  },
} as const;

/** The README's own "Works with" list (README.md), cut to the six the banner has room for: names, never marks. */
export const README_BANNER_WORKS_WITH = ["Xero", "QuickBooks Online", "HubSpot", "Pipedrive", "Slack", "Telegram"] as const;
