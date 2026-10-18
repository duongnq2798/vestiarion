import { ARC_MAINNET } from "@/lib/network";

/**
 * The payment the landing's proof leads with: the first one a workspace the team runs made on Arc mainnet, on Oct 7,
 * 2026, which went through every control there is (README "Mainnet proof"). Each fact is a record anyone can check, or
 * one the workspace's signed ledger holds:
 * - the trail, from that workspace's ledger: the bill added at 08:49:59 UTC (#1804); the model's decision to pay it 19 s
 *   later, refused by code as a first payment to a new address, `counterparty.new_payee` (#1806); a second person's
 *   approval at 09:43:17 UTC (#1815);
 * - the transfer, from the Arc mainnet explorer: `pay` on VestiarionSpendingLimit, called by the agent's wallet, which
 *   moved 0.1 USDC from the owner's passkey treasury to the payee in block 24,710,870 at 09:43:13 UTC, confirmed within
 *   half a second, for a 0.0035 USDC fee.
 * A past payment's facts do not change, so they are written here rather than read; the figures beside it are read live.
 */
export const FEATURED_PAYMENT = {
  network: ARC_MAINNET,
  amount: "0.10",
  feeUsdc: "0.0035",
  block: 24_710_870,
  confirmedAt: "2026-10-07T09:43:13Z",
  txHash: "0xcecef38e3f751bc118f8f00cee5bb5344679e84f89123d679b986b47d7f1dee6",
  contract: "0xd90cA89Fc318d0330Bb14eaeF78B72C3CA7E7fB6",
  steps: [
    {
      kind: "Decision",
      at: "2026-10-07T08:50:18Z",
      title: "The agent decided to pay it.",
      detail: "19 seconds after the bill was added: purchase order on file, goods received, supplier screened clear, within its limit.",
    },
    {
      kind: "Rules in code",
      at: "2026-10-07T08:50:18Z",
      title: "Code held it before anything was sent.",
      detail: "A first payment to a new address needs a second person. The model cannot override it.",
      rule: "counterparty.new_payee",
    },
    {
      kind: "Approval",
      at: "2026-10-07T09:43:17Z",
      title: "A second member read the reasons and approved it.",
    },
    {
      kind: "Settlement",
      at: "2026-10-07T09:43:13Z",
      title: "Paid on Arc mainnet, through the owner's spending-limit contract.",
      detail: "The agent's wallet can pay only through it, within the owner's daily and 7-day figures. Confirmed in under a second.",
    },
  ],
} as const;

export const featuredTxUrl = `${FEATURED_PAYMENT.network.explorer}/tx/${FEATURED_PAYMENT.txHash}`;
export const featuredContractUrl = `${FEATURED_PAYMENT.network.explorer}/address/${FEATURED_PAYMENT.contract}`;
