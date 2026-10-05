import crypto from "node:crypto";
import { changeCounterpartyAddress, CounterpartyAddressError, parseAddressInput } from "../counterparty-address";
import { platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { notifyPayeeAddress } from "../notifications/payee-address";
import type { PayeeLinkStatus, PayeePayment } from "../payee-journey";
import type { Provenance } from "../provenance";

/**
 * Payee links (docs/superpowers/specs/2026-09-30-payee-links-design.md).
 *
 * An owner or admin sends a payee a one-time link; the payee, with no
 * account, enters their own Arc address. That address change is stamped like
 * any other, so the agent holds every payment to it until a member confirms it
 * (R1): a link that leaks cannot move money on its own.
 *
 * A token is `vxp_` and 43 base64url characters (32 random bytes). Only the
 * SHA-256 of the secret is stored (migration 0039); it is shown once, when the
 * link is made. A link works once and expires after 7 days (R2).
 */

export const PAYEE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN = /^vxp_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export class PayeeLinkError extends Error {
  constructor(readonly code: "not_found") {
    super("Counterparty not found.");
    this.name = "PayeeLinkError";
  }
}

export function generatePayeeLinkToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxp_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed token; null for anything else, which is never looked up. */
export function payeeLinkHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

export interface PayeeLink {
  id: string;
  counterpartyId: string;
  expiresAt: string;
}

/**
 * Makes a link for a counterparty of the workspace in scope, revoking the payee's unused one, and records it.
 * `provenance` names the surface it came from in the entry (write API part 2, W3); the console passes none.
 */
export async function createPayeeLink(input: {
  orgId: string;
  actorId: string;
  counterpartyId: string;
  now?: number;
  provenance?: Provenance;
}): Promise<{ link: PayeeLink; token: string }> {
  const { token, secretHash } = generatePayeeLinkToken();
  const expiresAt = new Date((input.now ?? Date.now()) + PAYEE_LINK_TTL_MS).toISOString();
  const result = await platformDb()
    .rpc("create_payee_link", {
      p_org_id: input.orgId,
      p_counterparty_id: input.counterpartyId,
      p_token_hash: secretHash,
      p_by: input.actorId,
      p_expires_at: expiresAt,
    })
    .select("id, counterparty_id, expires_at")
    .single<{ id: string; counterparty_id: string; expires_at: string }>();
  if (result.error) {
    if (/^counterparty_not_found/.test(result.error.message)) throw new PayeeLinkError("not_found");
    throw new Error(result.error.message);
  }
  const link = { id: result.data.id, counterpartyId: result.data.counterparty_id, expiresAt: result.data.expires_at };

  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "compliance",
    action: "payee_link_created",
    summary: "Created a one-time link for a payee to enter their own address",
    detail: { by: input.actorId, counterpartyId: link.counterpartyId, linkId: link.id, expiresAt: link.expiresAt, ...input.provenance },
  });
  return { link, token };
}

/** The workspace's usable links, by counterparty. */
export async function listActivePayeeLinks(orgId: string, now: number = Date.now()): Promise<Map<string, { id: string; expiresAt: string }>> {
  const rows = unwrap(
    await platformDb()
      .from("payee_links")
      .select("id, counterparty_id, expires_at")
      .eq("org_id", orgId)
      .is("used_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date(now).toISOString())
  ) as Array<{ id: string; counterparty_id: string; expires_at: string }>;
  return new Map(rows.map((row) => [row.counterparty_id, { id: row.id, expiresAt: row.expires_at }]));
}

/** Revokes an unused link of the workspace, and records it; false when there was nothing to revoke. */
export async function revokePayeeLink(input: { orgId: string; actorId: string; linkId: string }): Promise<boolean> {
  const found = unwrap(
    await platformDb().from("payee_links").select("counterparty_id").eq("org_id", input.orgId).eq("id", input.linkId).limit(1)
  ) as Array<{ counterparty_id: string }>;
  const revoked = unwrap(
    await platformDb().rpc("revoke_payee_link", { p_org_id: input.orgId, p_link_id: input.linkId, p_by: input.actorId })
  ) as boolean;
  if (!revoked || found.length === 0) return false;

  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "compliance",
    action: "payee_link_revoked",
    summary: "Revoked a payee's address link",
    detail: { by: input.actorId, counterpartyId: found[0].counterparty_id, linkId: input.linkId },
  });
  return true;
}

export interface PayeeLinkPreview {
  orgName: string;
  counterpartyName: string;
  expiresAt: string;
  /** The chain the payee is paid on, so the page asks for an address there (CCTP payouts, review I3). */
  chain: string;
}

/** What the payee's page shows for a usable link; null for any other (R4). */
export async function previewPayeeLink(token: string, options: { withChain?: boolean } = {}): Promise<PayeeLinkPreview | null> {
  const hash = payeeLinkHash(token);
  if (!hash) return null;
  const rows = unwrap(await platformDb().rpc("payee_link_preview", { p_token_hash: hash })) as Array<{
    org_name: string;
    counterparty_name: string;
    expires_at: string;
  }>;
  const row = rows[0];
  if (!row) return null;
  // Read on its own (0044): a chain that cannot be read is Arc testnet, where every payee was paid before.
  let chain = "ARC-TESTNET";
  if (options.withChain !== false) {
    try {
      const found = unwrap(await platformDb().rpc("payee_link_chain", { p_token_hash: hash }));
      if (typeof found === "string" && found) chain = found;
    } catch (error) {
      console.error("payee link: chain not read", error instanceof Error ? error.message : error);
    }
  }
  return { orgName: row.org_name, counterpartyName: row.counterparty_name, expiresAt: row.expires_at, chain };
}

/**
 * What a payee's link shows (freelancer journey R1, R2): for a usable link, or one used within 30
 * days, the business, the payee, the address and whether it is confirmed, and the payee's payments;
 * null for any other link. A read that fails throws, so the page can say it could not load.
 */
export async function payeeLinkStatus(token: string): Promise<PayeeLinkStatus | null> {
  const hash = payeeLinkHash(token);
  if (!hash) return null;
  const result = await platformDb().rpc("payee_link_status", { p_token_hash: hash });
  if (result.error) throw new Error(result.error.message);
  const row = result.data as (Omit<PayeeLinkStatus, "payments"> & { payments: Array<Record<string, unknown>> }) | null;
  if (!row) return null;
  const payments: PayeePayment[] = (row.payments ?? []).map((payment) => ({
    kind: payment.kind === "invoice" ? "invoice" : "milestone",
    title: String(payment.title ?? ""),
    amount: Number(payment.amount),
    currency: payment.currency === "EURC" ? "EURC" : "USDC",
    status: String(payment.status ?? ""),
    txRef: typeof payment.txRef === "string" ? payment.txRef : null,
    settledAt: typeof payment.settledAt === "string" ? payment.settledAt : null,
    scheduledFor: typeof payment.scheduledFor === "string" ? payment.scheduledFor : null,
  }));
  return { ...row, payments };
}

export type PayeeSubmission =
  | { ok: true; orgName: string; unchanged: boolean }
  | { ok: false; reason: "invalid_address" | "checksum_address" | "invalid_link" };

/**
 * The payee's submission: the address is checked first, so a typo never uses
 * the link; then the link is claimed, once; then the address changes in the
 * workspace, as the link. The address already on file uses the link too. Any
 * other failure puts the link back and throws, so the payee can try again.
 */
export async function submitPayeeAddress(token: string, raw: string): Promise<PayeeSubmission> {
  const hash = payeeLinkHash(token);
  if (!hash) return { ok: false, reason: "invalid_link" };
  const parsed = parseAddressInput(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.checksum ? "checksum_address" : "invalid_address" };
  if (parsed.address === null) return { ok: false, reason: "invalid_address" };

  // The submission needs the business's name, not the chain.
  const preview = await previewPayeeLink(token, { withChain: false });
  if (!preview) return { ok: false, reason: "invalid_link" };
  const claimed = unwrap(await platformDb().rpc("claim_payee_link", { p_token_hash: hash })) as Array<{
    link_id: string;
    org_id: string;
    counterparty_id: string;
  }>;
  const link = claimed[0];
  if (!link) return { ok: false, reason: "invalid_link" };

  try {
    await withOrg(link.org_id, () =>
      changeCounterpartyAddress({ payeeLinkId: link.link_id, counterpartyId: link.counterparty_id, raw: parsed.address as string })
    );
  } catch (error) {
    if (error instanceof CounterpartyAddressError && error.code === "unchanged") return { ok: true, orgName: preview.orgName, unchanged: true };
    await platformDb().rpc("release_payee_link", { p_link_id: link.link_id });
    throw error;
  }
  // Nothing is paid to the new address until a member confirms it (R1), and
  // until now nobody was told it had arrived (pay a freelancer R4). Best
  // effort: it never throws.
  await notifyPayeeAddress({ orgId: link.org_id, orgName: preview.orgName, payeeName: preview.counterpartyName, address: parsed.address });
  return { ok: true, orgName: preview.orgName, unchanged: false };
}
