import { ARC_TESTNET } from "@/lib/network";

/**
 * The refusal the landing's safety section shows: a real decision, in a demo workspace the team runs in shadow mode on
 * Arc testnet, that the agent's daily spending limit stopped. Read from that workspace's signed ledger, entry #3710 at
 * Oct 16, 2026, 00:17 UTC, and its bill's card:
 * - the model decided to pay a 50.00 USDC bill on its 2% early-payment deadline, every check passing (purchase order
 *   PO-1042 on file and the goods received, the supplier screened clear, within its 59.54 USDC limit, no duplicate);
 * - code refused it before anything was signed or sent, `workspace.outflow_budget`: 50.00 USDC against the 15.00 USDC
 *   left of the agent's 15.00 USDC daily limit; the spending-limit contract on Arc would have refused it too
 *   (`OverDailyLimit`);
 * - no transaction was sent, and the bill waits for a person.
 * The supplier is named nowhere: its name is the workspace's. A past decision's facts do not change, so they are
 * written here rather than read.
 */
export const SAFETY_EXAMPLE = {
  network: ARC_TESTNET,
  mode: "shadow mode",
  at: "2026-10-16T00:17:27Z",
  entry: 3710,
  steps: [
    {
      kind: "The AI proposes",
      title: "Pay a 50.00 USDC bill today, on its early-payment deadline.",
      detail: "Purchase order on file, goods received, supplier screened clear, within its limit, no duplicate.",
      tone: "agent",
    },
    {
      kind: "A rule checks it",
      title: "It would pass the agent's 15.00 USDC daily spending limit.",
      detail: "The spending-limit contract on Arc would refuse it too (OverDailyLimit).",
      rule: "workspace.outflow_budget",
      tone: "held",
    },
    {
      kind: "The payment is held",
      title: "Refused before anything was signed or sent.",
      detail: "No transaction went out. The bill waits for a person, with the reason in plain words.",
      tone: "refused",
    },
  ],
} as const;
