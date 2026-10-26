import { ARC_TESTNET } from "@/lib/network";

/**
 * The payee lock's worked case on the landing's safety section (docs/superpowers/specs/2026-10-26-landing-payee-lock-
 * design.md PLL2): a real payment in the team's own workspace on Arc testnet, live and never in shadow mode, that the
 * lock held twice before it was paid. Read from that workspace's signed ledger, all on Oct 20, 2026, UTC:
 * - entry #4832 at 11:12:39: the payee lock turned on, with a 4-hour wait after an address changes;
 * - entry #4839 at 11:14:01: the vendor's payment address changed, to a fresh wallet holding 0 USDC;
 * - entry #4840 at 11:15:06: a 3.00 USDC bill from that vendor was added;
 * - entry #4843 at 11:15:17: the model decided to pay it, and code held it, `counterparty.address_unconfirmed`;
 * - the member who had entered the address tried to confirm it and was refused, "You entered or asked for this address,
 *   so someone else confirms it." (the payee lock spec's rollout record); the refusal itself is not a ledger entry;
 * - entry #4863 at 12:10:52: a second member confirmed the new address;
 * - entry #4866 at 12:11:00: the model decided to pay again, and code held it for the wait, `counterparty.cooling_off`;
 * - entry #4917 at 15:15:56: the held bill reopened, the wait over;
 * - entry #4919 at 15:16:07: the agent paid it.
 * The payment is transaction 0x49787501…0551 on Arc testnet: a success in block 68200055 at 15:16:04 UTC, 3 USDC from
 * the workspace's operating wallet to the new address, sent as a Circle smart-wallet user operation (EntryPoint
 * `handleOps`), not through the spending-limit contract. The lock is held by code and by people, not by a contract; the
 * transaction shows only that the payment settled after both holds ended, to the confirmed address, for the bill's
 * amount. Neither the vendor nor the workspace is named. A past decision's facts do not change, so they are written
 * here rather than read.
 */
export const PAYEE_LOCK_EXAMPLE = {
  network: ARC_TESTNET,
  day: "2026-10-20",
  mode: "live",
  lockOn: { at: "2026-10-20T11:12:39Z", entry: 4832, waitHours: 4 },
  steps: [
    {
      kind: "The address changes",
      at: "2026-10-20T11:14:01Z",
      entry: 4839,
      title: "The vendor's payment address changed to a new wallet.",
      detail: "The payee lock was already on, with a 4-hour wait after a change. The new wallet held 0 USDC. Then a 3.00 USDC bill from the vendor came in.",
      tone: "agent",
    },
    {
      kind: "Code holds it",
      at: "2026-10-20T11:15:17Z",
      entry: 4843,
      title: "The AI decided to pay the bill. Code held it.",
      detail: "No one had confirmed the new address.",
      rule: "counterparty.address_unconfirmed",
      tone: "held",
    },
    {
      kind: "A second person confirms",
      at: "2026-10-20T12:10:52Z",
      entry: 4863,
      title: "The member who entered the address could not confirm it. A second member did.",
      detail: 'The first was told: "You entered or asked for this address, so someone else confirms it." The second recorded how they checked it.',
      tone: "agent",
    },
    {
      kind: "Code holds it again",
      at: "2026-10-20T12:11:00Z",
      entry: 4866,
      title: "The AI decided to pay again. Code held it for the 4-hour wait.",
      detail: "The wait gives the real vendor time to notice a change they did not make.",
      rule: "counterparty.cooling_off",
      tone: "held",
    },
    {
      kind: "Paid",
      at: "2026-10-20T15:16:07Z",
      entry: 4919,
      title: "After the wait, the agent paid 3.00 USDC to the confirmed address.",
      detail: "The bill reopened once the wait was over, and the new wallet went from 0 to 3 USDC.",
      tone: "paid",
    },
  ],
  payment: {
    hash: "0x49787501b6738cc2653bfb93a51293d4f036ff85a41115dc7f5b5f07db720551",
    amount: "3.00 USDC",
    block: 68200055,
    /** When the block that settled it was made: the chain's time, not the ledger's. */
    confirmedAt: "2026-10-20T15:16:04Z",
  },
} as const;
