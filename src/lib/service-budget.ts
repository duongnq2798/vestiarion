import { SERVICE_DAILY_CAP_USDC } from "./agent/services";
import { gatewayBalance } from "./circle/gateway";
import { db, unwrap } from "./dal";

/**
 * The agent's service budget as the console shows it (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md
 * R4, R5): the Gateway signer's own balance, what the agent spent today against its daily most, and its last
 * purchases. Null for a workspace with no Gateway signer yet.
 */

export interface ServicePurchaseView {
  id: string;
  counterpartyName: string;
  address: string;
  status: "paid" | "refused" | "failed";
  priceUsdc: number | null;
  workspacesPaid: number | null;
  paymentsConfirmed: number | null;
  reason: string | null;
  createdAt: string;
}

export interface ServiceBudgetView {
  signerAddress: string;
  /** Null when Gateway did not answer. */
  balanceUsdc: number | null;
  spentToday: number;
  dailyCapUsdc: number;
  recent: ServicePurchaseView[];
}

export async function readServiceBudget(options: { fetch?: typeof fetch; now?: Date } = {}): Promise<ServiceBudgetView | null> {
  const signer = (await db().from("gateway_signers").select("address").maybeSingle()).data as { address: string } | null;
  if (!signer) return null;
  const today = (options.now ?? new Date()).toISOString().slice(0, 10);
  const [rows, balanceUsdc] = await Promise.all([
    db()
      .from("service_purchases")
      .select("id, address, status, price_usdc, result, reason, created_at, counterparties(name)")
      .order("created_at", { ascending: false })
      .limit(20),
    gatewayBalance(signer.address, { fetch: options.fetch }).catch(() => null),
  ]);
  // Before migration 0058 there is no table: the budget shows with no purchases.
  const purchases = (rows.error?.code === "42P01" ? [] : unwrap(rows)) as unknown as Array<{
    id: string;
    address: string;
    status: ServicePurchaseView["status"];
    price_usdc: string | number | null;
    result: { workspacesPaid?: number; paymentsConfirmed?: number } | null;
    reason: string | null;
    created_at: string;
    counterparties: { name: string } | null;
  }>;
  return {
    signerAddress: signer.address,
    balanceUsdc,
    spentToday: Math.round(purchases.filter((row) => row.status === "paid" && row.created_at.slice(0, 10) === today).reduce((sum, row) => sum + Number(row.price_usdc ?? 0), 0) * 1_000_000) / 1_000_000,
    dailyCapUsdc: SERVICE_DAILY_CAP_USDC,
    recent: purchases.slice(0, 5).map((row) => ({
      id: row.id,
      counterpartyName: row.counterparties?.name ?? "A counterparty",
      address: row.address,
      status: row.status,
      priceUsdc: row.price_usdc == null ? null : Number(row.price_usdc),
      workspacesPaid: row.result?.workspacesPaid ?? null,
      paymentsConfirmed: row.result?.paymentsConfirmed ?? null,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}
