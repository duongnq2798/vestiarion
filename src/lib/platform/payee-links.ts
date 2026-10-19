import crypto from "node:crypto";
import { simulatesPayments } from "../capability-read";
import { changeCounterpartyAddress, CounterpartyAddressError, parseAddressInput } from "../counterparty-address";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { notifyPayeeAddress } from "../notifications/payee-address";
import { choosablePayeeChains } from "../payee-chain-choice";
import { chainById } from "../payee-chains";
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
 *
 * A member may also have the link ask for the payee's invoice, and let the payee
 * choose the chain it is paid on (docs/superpowers/specs/2026-10-19-payee-invoice-link-design.md
 * P1, migration 0133). Both are off unless asked for; neither pays anything.
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

/** What a link asks of its payee beyond an address (payee invoice link P1): both off unless a member ticks them. */
export interface PayeeLinkOptions {
  /** Also ask for the payee's invoice. */
  asksInvoice?: boolean;
  /** Let the payee choose the chain its wallet receives USDC on. The caller has checked the payee may be offered it. */
  offersChain?: boolean;
}

/** PostgREST's "no such function" (PGRST202) or Postgres's (42883): migration 0133 has not run here yet. */
const missingFunction = (error: { code?: string }) => error.code === "PGRST202" || error.code === "42883";

/**
 * Makes a link for a counterparty of the workspace in scope, revoking the payee's unused one, and records it.
 * `provenance` names the surface it came from in the entry (write API part 2, W3); the console passes none. A link with
 * `options` is made with them in one transaction (0133's create_payee_link_with_options); one without is made by 0039's
 * function, as before. Either way, a used link of the payee still waiting for its invoice stops taking one (payee invoice
 * link P6): only the newest link speaks for the payee.
 */
export async function createPayeeLink(input: {
  orgId: string;
  actorId: string;
  counterpartyId: string;
  now?: number;
  provenance?: Provenance;
  options?: PayeeLinkOptions;
}): Promise<{ link: PayeeLink; token: string }> {
  const { token, secretHash } = generatePayeeLinkToken();
  const expiresAt = new Date((input.now ?? Date.now()) + PAYEE_LINK_TTL_MS).toISOString();
  const asksInvoice = input.options?.asksInvoice === true;
  const offersChain = input.options?.offersChain === true;
  const made = { p_org_id: input.orgId, p_counterparty_id: input.counterpartyId, p_token_hash: secretHash, p_by: input.actorId, p_expires_at: expiresAt };
  const result = await (asksInvoice || offersChain
    ? platformDb().rpc("create_payee_link_with_options", { ...made, p_asks_invoice: asksInvoice, p_offers_chain: offersChain })
    : platformDb().rpc("create_payee_link", made)
  )
    .select("id, counterparty_id, expires_at")
    .single<{ id: string; counterparty_id: string; expires_at: string }>();
  if (result.error) {
    if (/^counterparty_not_found/.test(result.error.message)) throw new PayeeLinkError("not_found");
    throw new Error(result.error.message);
  }
  const link = { id: result.data.id, counterpartyId: result.data.counterparty_id, expiresAt: result.data.expires_at };
  // A link made without options closes the payee's earlier invoice intake once it exists, so a failed create closes
  // nothing (review of the payee invoice link); one with options did it in its own transaction. Before 0133 no link
  // takes an invoice, so there is nothing to close. A close that fails leaves the new link standing and is logged.
  let closedInvoiceLinks = 0;
  if (!asksInvoice && !offersChain) {
    const closed = await platformDb().rpc("close_payee_invoice_intake", { p_org_id: input.orgId, p_counterparty_id: input.counterpartyId });
    if (closed.error && !missingFunction(closed.error)) {
      console.error("payee links: earlier invoice intake not closed", input.counterpartyId, closed.error.message);
    } else if (typeof closed.data === "number") {
      closedInvoiceLinks = closed.data;
    }
  }

  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "compliance",
    action: "payee_link_created",
    summary: asksInvoice
      ? "Created a one-time link for a payee to enter their own address and send their invoice"
      : "Created a one-time link for a payee to enter their own address",
    // The surface first: a chat surface's own `linkId` never takes the place of this link's, which the new payee check reads.
    detail: {
      ...input.provenance,
      by: input.actorId,
      counterpartyId: link.counterpartyId,
      linkId: link.id,
      expiresAt: link.expiresAt,
      ...(asksInvoice ? { asksInvoice: true } : {}),
      ...(offersChain ? { offersChain: true } : {}),
      ...(closedInvoiceLinks > 0 ? { closedInvoiceLinks } : {}),
    },
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

/**
 * The workspace's used links still waiting for their payee's invoice, by counterparty (payee invoice link P6): within the
 * 30 days a used link takes one, neither sent nor closed. Revoke stops them. Empty before migration 0133, or when they
 * cannot be read: Counterparties then shows what it did before.
 */
export async function listWaitingInvoiceLinks(orgId: string, now: number = Date.now()): Promise<Map<string, { id: string; until: string }>> {
  try {
    const rows = unwrap(
      await platformDb()
        .from("payee_links")
        .select("id, counterparty_id, used_at")
        .eq("org_id", orgId)
        .eq("asks_invoice", true)
        .is("revoked_at", null)
        .is("invoice_at", null)
        .is("invoice_closed_at", null)
        .gt("used_at", new Date(now - INVOICE_DAYS_MS).toISOString())
    ) as Array<{ id: string; counterparty_id: string; used_at: string }>;
    return new Map(rows.map((row) => [row.counterparty_id, { id: row.id, until: new Date(Date.parse(row.used_at) + INVOICE_DAYS_MS).toISOString() }]));
  } catch (error) {
    console.error("payee links: links waiting for an invoice not read", error instanceof Error ? error.message : "unknown error");
    return new Map();
  }
}

/** How long a used link still takes its payee's invoice, as 0133's functions count it. */
export const INVOICE_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Revokes an unused link of the workspace, or stops a used one still waiting for its invoice from taking it (payee
 * invoice link P6), and records it; null when there was nothing to revoke. The used link keeps showing its payee the
 * payment's status.
 */
export async function revokePayeeLink(input: { orgId: string; actorId: string; linkId: string }): Promise<"revoked" | "invoice_closed" | null> {
  const revoked = unwrap(
    await platformDb().rpc("revoke_payee_link", { p_org_id: input.orgId, p_link_id: input.linkId, p_by: input.actorId })
  ) as boolean;
  if (!revoked) return null;
  // Read after the revoke, so a payee who used the link a moment before is recorded as what the database did: a link
  // still unrevoked had only its invoice intake closed (review of the payee invoice link).
  const found = unwrap(
    await platformDb().from("payee_links").select("counterparty_id, revoked_at").eq("org_id", input.orgId).eq("id", input.linkId).limit(1)
  ) as Array<{ counterparty_id: string; revoked_at?: string | null }>;
  if (found.length === 0) return null;
  const invoiceOnly = !found[0].revoked_at;

  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "compliance",
    action: "payee_link_revoked",
    summary: invoiceOnly ? "Stopped a payee's link from taking their invoice" : "Revoked a payee's address link",
    detail: { by: input.actorId, counterpartyId: found[0].counterparty_id, linkId: input.linkId, ...(invoiceOnly ? { invoiceOnly: true } : {}) },
  });
  return invoiceOnly ? "invoice_closed" : "revoked";
}

export interface PayeeLinkPreview {
  orgName: string;
  counterpartyName: string;
  expiresAt: string;
  /** The chain the payee is paid on, so the page asks for an address there (CCTP payouts, review I3); null when not read. */
  chain: string | null;
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
  // Read on its own (0044); null when it was not read, rather than a network's chain assumed (network threading P3).
  let chain: string | null = null;
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
 * The chains a link's payee may choose among (payee invoice link P2), read in the paying workspace's scope through the
 * link's own row: the workspace's network and how it pays decide them. Empty when anything could not be read, and the
 * page then names the chain on file, as before.
 */
async function chainChoicesFor(hash: string): Promise<string[]> {
  try {
    const row = await platformDb().from("payee_links").select("org_id").eq("token_hash", hash).limit(1);
    const orgId = ((row.data ?? []) as Array<{ org_id?: string }>)[0]?.org_id;
    if (row.error || !orgId) return [];
    return await withOrg(orgId, async () => (await choosablePayeeChains()).map((chain) => chain.id));
  } catch (error) {
    console.error("payee link: chains to choose not read", error instanceof Error ? error.message : "unknown error");
    return [];
  }
}

/**
 * What a payee's link shows (freelancer journey R1, R2): for a usable link, or one used within 30
 * days, the business, the payee, the address and whether it is confirmed, and the payee's payments;
 * null for any other link. A read that fails throws, so the page can say it could not load. Since
 * 0133 it also says whether the link asks for an invoice and whether it arrived, and the chains the
 * payee may choose among (payee invoice link P2, P4): none unless the link offers the choice, its
 * payee is a vendor with no address and no payment, and the workspace can pay more than one chain.
 */
export async function payeeLinkStatus(token: string): Promise<PayeeLinkStatus | null> {
  const hash = payeeLinkHash(token);
  if (!hash) return null;
  const result = await platformDb().rpc("payee_link_status", { p_token_hash: hash });
  if (result.error) throw new Error(result.error.message);
  const found = result.data as (Omit<PayeeLinkStatus, "payments"> & { payments: Array<Record<string, unknown>>; chainOpen?: unknown }) | null;
  if (!found) return null;
  const { chainOpen, ...row } = found;
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
  const chainChoices = chainOpen === true ? await chainChoicesFor(hash) : [];
  return {
    ...row,
    asksInvoice: row.asksInvoice === true,
    offersChain: row.offersChain === true,
    invoiceSent: row.invoiceSent === true,
    addressMirror: row.addressMirror === true,
    chainChoices: chainChoices.length > 1 ? chainChoices : [],
    payments,
  };
}

/**
 * Whether the paying workspace simulates its payments, for the payee's page to say so in the words the workspace's own
 * pages use (capability and reasons R5). Read inside the workspace's scope, through the link's own row; false when the
 * link is unknown or anything could not be read, and the page then says what it said before. The payee's page never
 * says why a payment cannot be made now (payee links R3).
 */
export async function payeeLinkSimulates(token: string): Promise<boolean> {
  const hash = payeeLinkHash(token);
  if (!hash) return false;
  try {
    const row = await platformDb().from("payee_links").select("org_id").eq("token_hash", hash).limit(1);
    const orgId = ((row.data ?? []) as Array<{ org_id?: string }>)[0]?.org_id;
    if (row.error || !orgId) return false;
    const org = await platformDb().from("orgs").select("mode").eq("id", orgId).limit(1);
    const mode = ((org.data ?? []) as Array<{ mode?: string }>)[0]?.mode === "sandbox" ? "sandbox" : "live";
    return await withOrg(orgId, async () => simulatesPayments(mode));
  } catch (error) {
    console.error("payee link: chain mode not read", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}

export type PayeeSubmission =
  | { ok: true; orgName: string; unchanged: boolean }
  | { ok: false; reason: "invalid_address" | "checksum_address" | "invalid_link" | "chain_closed" };

/** The payee chose a chain the workspace no longer lets it choose: the link is put back, nothing is written. */
class ChainClosedError extends Error {
  constructor() {
    super("The chain can no longer be chosen.");
    this.name = "ChainClosedError";
  }
}

/** Whether the link offers its payee the choice of chain, and the payee may still make it (0133's `chainOpen`). */
async function chainOpenFor(hash: string): Promise<boolean> {
  const result = await platformDb().rpc("payee_link_status", { p_token_hash: hash });
  if (result.error) throw new Error(result.error.message);
  return (result.data as { chainOpen?: unknown } | null)?.chainOpen === true;
}

/**
 * How the members' email about a payee's submission is sent: `defer` runs it after the payee has its answer (`after`
 * in a Server Action), so the page moves on without waiting for the email; without it, the email is awaited.
 */
export interface PayeeSendOptions {
  defer?: (work: () => Promise<unknown>) => void;
}

/** The members' email, after the answer when the caller defers it, or awaited. Best effort: the email never throws. */
export async function tellMembers(work: () => Promise<unknown>, options: PayeeSendOptions): Promise<void> {
  if (options.defer) options.defer(work);
  else await work();
}

/**
 * The payee's submission: the address is checked first, so a typo never uses
 * the link; then the link is claimed, once; then the address changes in the
 * workspace, as the link. The address already on file uses the link too. Any
 * other failure puts the link back and throws, so the payee can try again.
 *
 * `chain`, on a link that lets the payee choose where it is paid (payee invoice
 * link P2), is checked before the link is used (the link offers it, its payee is
 * a vendor with no address and no payment) and again in the workspace's scope
 * (a chain it pays on, more than one to choose from), and is written with the
 * address in one compare-and-set. A choice no longer open uses nothing.
 */
export async function submitPayeeAddress(token: string, raw: string, options: { chain?: string } & PayeeSendOptions = {}): Promise<PayeeSubmission> {
  const hash = payeeLinkHash(token);
  if (!hash) return { ok: false, reason: "invalid_link" };
  const parsed = parseAddressInput(raw);
  if (!parsed.ok) return { ok: false, reason: parsed.checksum ? "checksum_address" : "invalid_address" };
  if (parsed.address === null) return { ok: false, reason: "invalid_address" };

  // The submission needs the business's name, not the chain.
  const preview = await previewPayeeLink(token, { withChain: false });
  if (!preview) return { ok: false, reason: "invalid_link" };
  const chain = options.chain;
  if (chain !== undefined && !(await chainOpenFor(hash))) return { ok: false, reason: "chain_closed" };
  const claimed = unwrap(await platformDb().rpc("claim_payee_link", { p_token_hash: hash })) as Array<{
    link_id: string;
    org_id: string;
    counterparty_id: string;
  }>;
  const link = claimed[0];
  if (!link) return { ok: false, reason: "invalid_link" };

  try {
    await withOrg(link.org_id, async () => {
      if (chain !== undefined && !(await choosablePayeeChains()).some((entry) => entry.id === chain)) throw new ChainClosedError();
      return changeCounterpartyAddress({
        payeeLinkId: link.link_id,
        counterpartyId: link.counterparty_id,
        raw: parsed.address as string,
        ...(chain !== undefined ? { chain } : {}),
      });
    });
  } catch (error) {
    if (error instanceof CounterpartyAddressError && error.code === "unchanged") return { ok: true, orgName: preview.orgName, unchanged: true };
    await platformDb().rpc("release_payee_link", { p_link_id: link.link_id });
    if (error instanceof ChainClosedError) return { ok: false, reason: "chain_closed" };
    throw error;
  }
  // Nothing is paid to the new address until a member confirms it (R1), and
  // until now nobody was told it had arrived (pay a freelancer R4). Best
  // effort: it never throws. After the payee's answer when the caller defers it.
  const address = parsed.address;
  await tellMembers(
    () =>
      notifyPayeeAddress({
        orgId: link.org_id,
        orgName: preview.orgName,
        payeeName: preview.counterpartyName,
        address,
        ...(chain !== undefined ? { chainLabel: chainById(chain).label } : {}),
      }),
    options
  );
  return { ok: true, orgName: preview.orgName, unchanged: false };
}

export type PayeeKeep = { ok: true; orgName: string } | { ok: false; reason: "invalid_link" | "no_address" };

/**
 * The payee keeps the address the business has on file and moves on to its invoice (payee invoice link P4), on a link
 * that asks for one: the link is used, once, as sending that same address uses it, nothing changes, and
 * `counterparty_address_kept` is signed. A mirror address Vestiarion made in shadow mode is not the payee's to keep, and
 * a payee with no address has none: the link is put back.
 */
export async function keepPayeeAddress(token: string): Promise<PayeeKeep> {
  const hash = payeeLinkHash(token);
  if (!hash) return { ok: false, reason: "invalid_link" };
  const status = await platformDb().rpc("payee_link_status", { p_token_hash: hash });
  if (status.error) throw new Error(status.error.message);
  const open = status.data as { orgName?: unknown; asksInvoice?: unknown; linkState?: unknown } | null;
  if (!open || open.asksInvoice !== true || open.linkState !== "open") return { ok: false, reason: "invalid_link" };
  const claimed = unwrap(await platformDb().rpc("claim_payee_link", { p_token_hash: hash })) as Array<{
    link_id: string;
    org_id: string;
    counterparty_id: string;
  }>;
  const link = claimed[0];
  if (!link) return { ok: false, reason: "invalid_link" };

  let kept: { name: string; address: string } | null;
  try {
    kept = await withOrg(link.org_id, async () => {
      const found = unwrap(
        await db().from("counterparties").select("name, address, mirror_wallet_id").eq("id", link.counterparty_id).limit(1)
      ) as Array<{ name: string; address: string | null; mirror_wallet_id?: string | null }>;
      const row = found[0];
      if (!row?.address || row.mirror_wallet_id) return null;
      await appendLedgerEntryBestEffort(link.org_id, {
        actor: "human",
        domain: "compliance",
        action: "counterparty_address_kept",
        summary: `${row.name} kept the address on file through their payee link`,
        detail: { by: null, via: "payee_link", linkId: link.link_id, counterpartyId: link.counterparty_id, address: row.address },
      });
      return { name: row.name, address: row.address };
    });
  } catch (error) {
    await platformDb().rpc("release_payee_link", { p_link_id: link.link_id });
    throw error;
  }
  if (!kept) {
    await platformDb().rpc("release_payee_link", { p_link_id: link.link_id });
    return { ok: false, reason: "no_address" };
  }
  return { ok: true, orgName: typeof open.orgName === "string" ? open.orgName : "" };
}
