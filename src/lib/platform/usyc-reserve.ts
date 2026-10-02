import { arcRpcUrl } from "../circle/arcFees";
import { usycEntitlements, type UsycReadOptions } from "../circle/usyc";
import { db, platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";

/**
 * Turning a workspace's real USYC reserve on (docs/superpowers/specs/2026-10-02-usyc-live-design.md
 * R1). Runs inside the organization's scope; who may do it is checked by the action (`treasury.manage`)
 * and again by `enable_usyc_reserve` (0054), which is told who is acting.
 *
 * Before anything is written it checks, on Arc testnet, that Circle allowlisted the operating wallet
 * to buy USYC and the reserve wallet to sell it, and that the simulated reserve holds nothing, so a
 * simulated balance is never taken for real USYC.
 */

export type UsycReserveErrorCode = "not_live" | "no_wallets" | "simulated_reserve" | "not_allowlisted" | "already_live" | "not_permitted" | "unreachable";

export class UsycReserveError extends Error {
  constructor(
    readonly code: UsycReserveErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UsycReserveError";
  }
}

export interface UsycReserveStatus {
  /** When it was turned on; null while the reserve is simulated. */
  liveAt: string | null;
  mode: "live" | "sandbox";
  operatingAddress: string | null;
  reserveAddress: string | null;
  /** The reserve's balance as last stored: its USYC's USDC value once live, the simulated figure before. */
  reserveBalance: number;
}

interface TreasuryWallets {
  operating: { id: string; address: string | null; balance: string };
  reserve: { id: string; address: string | null; balance: string };
}

async function treasuryWallets(): Promise<Partial<TreasuryWallets>> {
  const rows = unwrap(await db().from("accounts").select("id, kind, address, balance").in("kind", ["operating", "reserve"])) as Array<{
    id: string;
    kind: string;
    address: string | null;
    balance: string;
  }>;
  return { operating: rows.find((row) => row.kind === "operating"), reserve: rows.find((row) => row.kind === "reserve") };
}

export async function usycReserveStatus(orgId: string): Promise<UsycReserveStatus> {
  const org = unwrap(await platformDb().from("orgs").select("mode, usyc_live_at").eq("id", orgId).single()) as { mode: "live" | "sandbox"; usyc_live_at: string | null };
  const wallets = await treasuryWallets();
  return {
    liveAt: org.usyc_live_at,
    mode: org.mode,
    operatingAddress: wallets.operating?.address ?? null,
    reserveAddress: wallets.reserve?.address ?? null,
    reserveBalance: Number(wallets.reserve?.balance ?? 0),
  };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function enableUsycReserve(input: { orgId: string; actorId: string; read?: UsycReadOptions }): Promise<{ liveAt: string; operatingAddress: string; reserveAddress: string }> {
  const status = await usycReserveStatus(input.orgId);
  if (status.liveAt) throw new UsycReserveError("already_live", "The USYC reserve is already on.");
  if (status.mode !== "live") throw new UsycReserveError("not_live", "Take the workspace live first: only a live workspace's wallets can hold USYC.");
  const operating = status.operatingAddress;
  const reserve = status.reserveAddress;
  if (!operating || !reserve || !ADDRESS.test(operating) || !ADDRESS.test(reserve)) {
    throw new UsycReserveError("no_wallets", "The operating and reserve accounts need their wallets first. Create them under Go live.");
  }
  if (status.reserveBalance > 0) {
    throw new UsycReserveError(
      "simulated_reserve",
      `The simulated reserve still holds ${status.reserveBalance} USDC. Turn this on once the agent has moved it back to operating, so no simulated balance is counted as USYC.`
    );
  }

  let allowed: { operating: boolean; reserve: boolean };
  try {
    allowed = await usycEntitlements({ operating, reserve }, input.read ?? { rpcUrl: arcRpcUrl() });
  } catch {
    throw new UsycReserveError("unreachable", "Arc testnet did not answer the allowlist check. Try again in a moment.");
  }
  const missing = [!allowed.operating ? `the operating wallet (${operating}), to buy USYC` : null, !allowed.reserve ? `the reserve wallet (${reserve}), to sell it` : null].filter(Boolean);
  if (missing.length > 0) {
    throw new UsycReserveError("not_allowlisted", `Circle has not allowlisted ${missing.join(", nor ")}. Ask Circle Support to allowlist it for USYC on Arc testnet, then try again.`);
  }

  const result = await platformDb().rpc("enable_usyc_reserve", { p_org_id: input.orgId, p_actor: input.actorId }).single<string>();
  if (result.error) {
    if (/^already_live/.test(result.error.message)) throw new UsycReserveError("already_live", "The USYC reserve is already on.");
    if (/^(usyc_not_permitted|not_a_member)/.test(result.error.message)) throw new UsycReserveError("not_permitted", "Only an owner or admin can turn the USYC reserve on.");
    if (/^not_live/.test(result.error.message)) throw new UsycReserveError("not_live", "Take the workspace live first: only a live workspace's wallets can hold USYC.");
    throw new Error(result.error.message);
  }

  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "treasury",
    action: "usyc_reserve_enabled",
    summary: "Turned the real USYC reserve on: idle cash now earns in USYC on Arc testnet",
    detail: { by: input.actorId, operatingAddress: operating, reserveAddress: reserve },
  });
  return { liveAt: result.data as string, operatingAddress: operating, reserveAddress: reserve };
}
