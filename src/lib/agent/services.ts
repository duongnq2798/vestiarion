import { workspaceNetwork } from "../workspace-network";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { currentOrgConfig } from "../context";
import { unwrap, type OrgDb } from "../dal";
import { gatewayBalance } from "../circle/gateway";
import { addressUnconfirmed } from "../counterparty-address";
import { appendLedgerEntry } from "../ledger";
import type { PayeeHistory } from "../platform/payee-history";
import { publicOrigin } from "../public-origin";
import { buyX402, circleTypedData, PurchaseRefused, type Purchase, type X402Signer } from "../x402/buyer";
import { isArcAddress, PAYEE_HISTORY_PATH, payeeHistoryRequirements } from "../x402/offer";
import { pausedPaymentNote } from "./pause";
import { paymentsDisabled } from "../payments-switch";

/**
 * The cycle's `services` stage (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md R3–R7): before
 * a first payment to an address, the agent buys that address's history across Vestiarion over x402, from the
 * service budget a person gave its Gateway signer. Code bounds every purchase; the model only reads the answer.
 * Returns, by counterparty, the history bought within the last 7 days, for the AP and contractor prompts.
 */

/** The most one call may cost (R5). */
export const SERVICE_MAX_PRICE_USDC = 0.01;
/** The most the agent spends on services in one UTC day (R5). */
export const SERVICE_DAILY_CAP_USDC = 0.05;
/** The most purchases in one cycle (R5). */
export const SERVICE_MAX_PER_CYCLE = 3;
/** How long a bought history answers for (R3). */
export const HISTORY_FRESH_DAYS = 7;
/** How long after a refused or failed purchase an address is not tried again, so a cycle a minute does not sign one each time. */
const RETRY_AFTER_HOURS = 24;

/** What a decision is shown of a bought history (R6). */
export interface AddressHistoryFact {
  /** What the figures count, for the model reading them. */
  about: string;
  workspacesPaid: number;
  paymentsConfirmed: number;
  firstPaidAt: string | null;
  lastPaidAt: string | null;
  boughtAt: string;
  priceUsdc: number | null;
}

export type BuyHistory = (address: string, beforePay: (priceUsdc: number) => Promise<void>) => Promise<Purchase<PayeeHistory>>;

interface Candidate {
  counterpartyId: string;
  name: string;
  address: string;
}

interface PurchaseRow {
  counterparty_id: string;
  address: string;
  status: "paid" | "refused" | "failed";
  price_usdc: string | number | null;
  result: PayeeHistory | null;
  created_at: string;
}

const day = (now: Date) => now.toISOString().slice(0, 10);

const ABOUT =
  "Confirmed live payments to this counterparty's address by Vestiarion workspaces other than this one, bought before this workspace's first payment to it. 0 means no other business here has paid it.";

export async function buyPayeeHistories(input: {
  db: OrgDb;
  live: boolean;
  lines: Array<{ domain: string; message: string }>;
  now?: Date;
  /** The purchase itself; the workspace's Gateway signer paying Vestiarion's endpoint unless a test gives its own. */
  buy?: BuyHistory;
  /** The purse: the signer's own Gateway balance, read once; Gateway's answer unless a test gives its own. */
  purse?: () => Promise<number>;
}): Promise<Map<string, AddressHistoryFact>> {
  const { db } = input;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - HISTORY_FRESH_DAYS * 86_400_000).toISOString();
  const purchases = unwrap(
    await db.from("service_purchases").select("counterparty_id, address, status, price_usdc, result, created_at").gte("created_at", since).order("created_at", { ascending: false })
  ) as PurchaseRow[];

  const facts = new Map<string, AddressHistoryFact>();
  const fact = (row: { result: PayeeHistory | null; created_at: string; price_usdc: string | number | null }): AddressHistoryFact | null =>
    row.result
      ? {
          about: ABOUT,
          workspacesPaid: Number(row.result.workspacesPaid ?? 0),
          paymentsConfirmed: Number(row.result.paymentsConfirmed ?? 0),
          firstPaidAt: row.result.firstPaidAt ?? null,
          lastPaidAt: row.result.lastPaidAt ?? null,
          boughtAt: row.created_at,
          priceUsdc: row.price_usdc == null ? null : Number(row.price_usdc),
        }
      : null;
  // The newest paid answer for each counterparty, while its address is still the one looked up.
  const paidRows = purchases.filter((row) => row.status === "paid");
  if (paidRows.length > 0) {
    const current = unwrap(
      await db.from("counterparties").select("id, address").in("id", [...new Set(paidRows.map((row) => row.counterparty_id))])
    ) as Array<{ id: string; address: string | null }>;
    const addressOf = new Map(current.map((cp) => [cp.id, cp.address?.toLowerCase() ?? null]));
    for (const row of paidRows) {
      if (facts.has(row.counterparty_id) || addressOf.get(row.counterparty_id) !== row.address.toLowerCase()) continue;
      const found = fact(row);
      if (found) facts.set(row.counterparty_id, found);
    }
  }

  if (!input.live) return facts;
  // A purchase is paid from the workspace's Gateway balance, on its network (network threading P5). Where Gateway does
  // not run, the agent leaves purchases out, without a line every cycle (mainnet pre-flight).
  if (workspaceNetwork().gateway === null) return facts;
  const signer = (await db.from("gateway_signers").select("circle_wallet_id, address").maybeSingle()).data as { circle_wallet_id: string; address: string } | null;
  if (!signer && !input.buy) return facts;
  // Spending is moving money: a paused agent buys nothing, and nothing is bought while payments are off (payment safety S9).
  if (await pausedPaymentNote()) return facts;
  if (await paymentsDisabled()) return facts;

  const candidates = await firstPaymentsAwaiting(db);
  const retryAfter = now.getTime() - RETRY_AFTER_HOURS * 3_600_000;
  const due = candidates.filter((candidate) => {
    const address = candidate.address.toLowerCase();
    return !purchases.some(
      (row) => row.address.toLowerCase() === address && (row.status === "paid" || Date.parse(row.created_at) >= retryAfter)
    );
  });
  if (due.length === 0) return facts;

  let spentToday = purchases
    .filter((row) => row.status === "paid" && row.created_at.slice(0, 10) === day(now))
    .reduce((sum, row) => sum + Number(row.price_usdc ?? 0), 0);
  let purse: number | null = null;
  const readPurse = input.purse ?? (() => gatewayBalance(workspaceNetwork(), (signer as { address: string }).address));
  const buy = input.buy ?? payeeHistoryBuyer(signer as { circle_wallet_id: string; address: string });

  for (const candidate of due.slice(0, SERVICE_MAX_PER_CYCLE)) {
    const beforePay = async (priceUsdc: number) => {
      if (spentToday + priceUsdc > SERVICE_DAILY_CAP_USDC + 1e-9) {
        throw new PurchaseRefused("budget.day", `It would take today's service spending past ${SERVICE_DAILY_CAP_USDC} USDC (${round(spentToday)} USDC spent).`);
      }
      purse ??= await readPurse();
      if (purse + 1e-9 < priceUsdc) {
        throw new PurchaseRefused("purse.short", `The agent's service budget holds ${purse} USDC, less than the ${priceUsdc} USDC asked. Add to it on Treasury.`);
      }
    };
    const seller = `${publicOrigin()}${PAYEE_HISTORY_PATH}`;
    try {
      const bought = await buy(candidate.address, beforePay);
      spentToday += bought.priceUsdc;
      if (purse !== null) purse = round(purse - bought.priceUsdc);
      const row = await record(db, candidate, seller, { status: "paid", price_usdc: bought.priceUsdc, payer: bought.payer, pay_to: bought.payTo, nonce: bought.nonce, settlement: bought.settlement, result: bought.data });
      const history = bought.data;
      await appendLedgerEntry({
        actor: "agent",
        domain: "compliance",
        action: "service_purchased",
        summary: `Bought the payment history of ${candidate.name}'s address for ${bought.priceUsdc} USDC over x402: paid by ${history.workspacesPaid} ${history.workspacesPaid === 1 ? "workspace" : "workspaces"} before`,
        detail: {
          purchaseId: row,
          counterpartyId: candidate.counterpartyId,
          address: candidate.address,
          seller,
          priceUsdc: bought.priceUsdc,
          payer: bought.payer,
          payTo: bought.payTo,
          nonce: bought.nonce,
          settlement: bought.settlement,
          result: { workspacesPaid: history.workspacesPaid, paymentsConfirmed: history.paymentsConfirmed, firstPaidAt: history.firstPaidAt, lastPaidAt: history.lastPaidAt, asOf: history.asOf },
        },
      });
      facts.set(candidate.counterpartyId, {
        about: ABOUT,
        workspacesPaid: history.workspacesPaid,
        paymentsConfirmed: history.paymentsConfirmed,
        firstPaidAt: history.firstPaidAt,
        lastPaidAt: history.lastPaidAt,
        boughtAt: now.toISOString(),
        priceUsdc: bought.priceUsdc,
      });
      input.lines.push({ domain: "compliance", message: `${candidate.name}: bought its address's payment history for ${bought.priceUsdc} USDC (paid by ${history.workspacesPaid} other ${history.workspacesPaid === 1 ? "workspace" : "workspaces"} before)` });
    } catch (error) {
      const refused = error instanceof PurchaseRefused;
      const reason = error instanceof Error ? error.message : "The purchase failed";
      const row = await record(db, candidate, seller, { status: refused ? "refused" : "failed", reason });
      await appendLedgerEntry({
        actor: "agent",
        domain: "compliance",
        action: refused ? "service_purchase_refused" : "service_purchase_failed",
        summary: `${refused ? "Did not buy" : "Could not buy"} the payment history of ${candidate.name}'s address: ${reason}`,
        detail: { purchaseId: row, counterpartyId: candidate.counterpartyId, address: candidate.address, seller, ...(refused ? { rule: (error as PurchaseRefused).rule } : {}), reason },
      });
      input.lines.push({ domain: "compliance", message: `${candidate.name}: payment history not bought (${reason})` });
      // The day's budget or the purse refuses every purchase after it too.
      if (refused && ((error as PurchaseRefused).rule === "budget.day" || (error as PurchaseRefused).rule === "purse.short")) break;
    }
  }
  return facts;
}

const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

async function record(db: OrgDb, candidate: Candidate, seller: string, row: Record<string, unknown>): Promise<string | null> {
  const inserted = await db
    .from("service_purchases")
    .insert({ counterparty_id: candidate.counterpartyId, address: candidate.address, seller_url: seller, ...row })
    .select("id")
    .single<{ id: string }>();
  if (inserted.error) throw new Error(inserted.error.message);
  return inserted.data?.id ?? null;
}

/**
 * Counterparties about to be paid for the first time at their address (R3): a payable or a verified milestone
 * awaiting a decision, an Arc address with no change awaiting confirmation, and no confirmed payment from this
 * workspace to it.
 */
async function firstPaymentsAwaiting(db: OrgDb): Promise<Candidate[]> {
  const [payables, milestones, paid] = await Promise.all([
    db.from("invoices").select("counterparty_id").eq("direction", "payable").in("status", ["pending", "matched", "scheduled"]),
    db.from("milestones").select("contractor_id").eq("verified", true).eq("status", "verified"),
    db.from("payment_intents").select("destination").eq("status", "confirmed"),
  ]);
  const ids = new Set<string>([
    ...((unwrap(payables) as Array<{ counterparty_id: string }>).map((row) => row.counterparty_id)),
    ...((unwrap(milestones) as Array<{ contractor_id: string }>).map((row) => row.contractor_id)),
  ]);
  if (ids.size === 0) return [];
  const paidTo = new Set((unwrap(paid) as Array<{ destination: string }>).map((row) => row.destination.toLowerCase()));
  const counterparties = unwrap(
    await db.from("counterparties").select("id, name, address, address_changed_at, address_confirmed_at").in("id", [...ids])
  ) as Array<{ id: string; name: string; address: string | null; address_changed_at: string | null; address_confirmed_at: string | null }>;
  return counterparties
    .filter((cp) => isArcAddress(cp.address) && !addressUnconfirmed(cp.address_changed_at, cp.address_confirmed_at) && !paidTo.has((cp.address as string).toLowerCase()))
    .map((cp) => ({ counterpartyId: cp.id, name: cp.name, address: cp.address as string }));
}

/** The workspace's Gateway signer buying from Vestiarion's own endpoint, the only seller allowed (R5). */
function payeeHistoryBuyer(signer: { circle_wallet_id: string; address: string }): BuyHistory {
  const chain = currentOrgConfig().chain;
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new Error("This workspace has no Circle credentials.");
  const client = initiateDeveloperControlledWalletsClient({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });
  const x402Signer: X402Signer = {
    address: signer.address,
    signTypedData: async (params) => {
      const signed = await client.signTypedData({ walletId: signer.circle_wallet_id, data: circleTypedData(params), memo: "x402 payee history" });
      const signature = signed.data?.signature;
      if (!signature) throw new Error("Circle returned no signature for the x402 payment; nothing was paid");
      return signature;
    },
  };
  const origin = new URL(publicOrigin());
  return (address, beforePay) =>
    buyX402<PayeeHistory>({
      url: `${origin.origin}${PAYEE_HISTORY_PATH}?address=${address}`,
      expected: payeeHistoryRequirements(),
      maxPriceUsdc: SERVICE_MAX_PRICE_USDC,
      allowed: (url) => url.origin === origin.origin && url.pathname === PAYEE_HISTORY_PATH,
      signer: x402Signer,
      beforePay,
    });
}
