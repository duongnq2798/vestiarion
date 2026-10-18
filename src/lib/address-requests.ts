import { z } from "zod";
import { simulatesPayments } from "./capability-read";
import type { Actor } from "./commands/actor";
import { issuePayeeLink } from "./commands/payee-links";
import { gate } from "./commands/policy";
import { db, unwrap } from "./dal";
import { addressRequestEmail } from "./email/address-request";
import { sendEmail } from "./email/send";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { listActivePayeeLinks } from "./platform/payee-links";
import { publicOrigin } from "./public-origin";
import { workspaceNetwork } from "./workspace-network";

/**
 * Ask every payee for an address at once (docs/superpowers/specs/2026-10-18-ask-every-payee-design.md A1-A6): each
 * vendor or contractor with no address of its own and no unused link out gets its own one-time payee link, made through
 * the command a single link uses, and emailed to its notice email when it has one. The links are shown once for the
 * rest. The workspace signs `payee_addresses_requested` beside each link's own entry.
 */

export const PAYEE_ADDRESSES_REQUESTED = "payee_addresses_requested";
/** The most payees asked at one press (A2). */
export const ASK_MAX = 25;

/** A payee the panel would ask, and how its link would go (A3). */
export interface PayeeToAsk {
  id: string;
  name: string;
  /** Its notice email, where the link is sent; null when it has none and its link is shown to copy. */
  email: string | null;
  /** Paid at a mirror address in shadow mode, with no address of its own. */
  mirror: boolean;
}

export interface AskablePayees {
  payees: PayeeToAsk[];
  /** Payees beyond the first `ASK_MAX`, for the next press. */
  more: number;
  /** Payees with no address of their own that have an unused link out already. */
  linksOut: number;
}

type PayeeRow = {
  id: string;
  name: string;
  role: string;
  address: string | null;
  mirror_wallet_id?: string | null;
  notice_email?: string | null;
  sample?: boolean | null;
};

/** A vendor or contractor, never sample data, with no address of its own: none, or a mirror address (A2). */
const needsAddress = (row: PayeeRow) => row.role !== "client" && row.sample !== true && (!row.address || Boolean(row.mirror_wallet_id));

const toAsk = (row: PayeeRow): PayeeToAsk => ({ id: row.id, name: row.name, email: row.notice_email?.trim() || null, mirror: Boolean(row.mirror_wallet_id) });

/** Who the panel asks, from the workspace's counterparties and its unused links: by name, at most `ASK_MAX` (A2). */
export function askablePayees(rows: ReadonlyArray<PayeeRow>, linksOut: ReadonlyMap<string, unknown>): AskablePayees {
  const needing = rows.filter(needsAddress).sort((a, b) => a.name.localeCompare(b.name));
  const eligible = needing.filter((row) => !linksOut.has(row.id));
  return { payees: eligible.slice(0, ASK_MAX).map(toAsk), more: Math.max(0, eligible.length - ASK_MAX), linksOut: needing.length - eligible.length };
}

export interface AddressRequests {
  /** The payees whose link went by email. */
  emailed: string[];
  /** Links shown once to copy: no email to send them to, or the email did not go. */
  links: Array<{ counterpartyId: string; name: string; url: string; expiresAt: string }>;
  /** Payees whose link could not be made. */
  notMade: string[];
  /** Payees listed on the page that no longer needed asking when the press arrived. */
  skipped: number;
}

const idsSchema = z.array(z.string().uuid()).min(1).max(ASK_MAX);

/**
 * Asks the payees listed on the page that still need an address (A4), in the workspace in scope. Refused for a role that
 * cannot make a payee link, and for no payee or more than `ASK_MAX`.
 */
export async function askPayeesForAddresses(input: {
  actor: Actor;
  orgName: string;
  counterpartyIds: string[];
}): Promise<{ ok: true; asked: AddressRequests } | { ok: false; message: string }> {
  const refusal = gate(input.actor, "payee_link.create");
  if (refusal) return { ok: false, message: refusal.message };
  const ids = idsSchema.safeParse([...new Set(input.counterpartyIds)]);
  if (!ids.success) return { ok: false, message: `Choose between 1 and ${ASK_MAX} payees.` };

  const [rows, linksOut] = await Promise.all([
    db().from("counterparties").select("id, name, role, address, mirror_wallet_id, notice_email, sample").in("id", ids.data),
    listActivePayeeLinks(input.actor.orgId),
  ]);
  // Re-read now: a payee given an address, or a link, since the page loaded is not asked again.
  const payees = askablePayees(unwrap(rows) as PayeeRow[], linksOut).payees;
  const origin = publicOrigin();
  const network = workspaceNetwork().id;
  const simulated = simulatesPayments(input.actor.mode);

  const asked: AddressRequests = { emailed: [], links: [], notMade: [], skipped: ids.data.length - payees.length };
  const signed: Array<{ counterpartyId: string; linkId: string; emailed: boolean }> = [];
  const notMadeIds: string[] = [];
  for (const payee of payees) {
    const outcome = await issuePayeeLink(input.actor, { counterpartyId: payee.id });
    if (!outcome.ok) {
      asked.notMade.push(payee.name);
      notMadeIds.push(payee.id);
      continue;
    }
    let emailed = false;
    if (payee.email) {
      const email = addressRequestEmail({
        orgName: input.orgName,
        payeeName: payee.name,
        link: outcome.url,
        expiresAt: new Date(outcome.expiresAt),
        origin,
        network,
        ...(simulated ? { simulated: true } : {}),
      });
      try {
        emailed = (await sendEmail({ to: payee.email, ...email, meter: "address_request" })).sent;
      } catch (error) {
        console.error("ask every payee: link not emailed", error instanceof Error ? error.message : "unknown error");
      }
    }
    signed.push({ counterpartyId: payee.id, linkId: outcome.linkId, emailed });
    if (emailed) asked.emailed.push(payee.name);
    else asked.links.push({ counterpartyId: payee.id, name: payee.name, url: outcome.url, expiresAt: outcome.expiresAt });
  }

  if (signed.length > 0 || notMadeIds.length > 0) {
    await appendLedgerEntryBestEffort(input.actor.orgId, {
      actor: "human",
      domain: "compliance",
      action: PAYEE_ADDRESSES_REQUESTED,
      summary: `Asked ${signed.length} ${signed.length === 1 ? "payee" : "payees"} for an address, ${asked.emailed.length} by email`,
      detail: { by: input.actor.userId, links: signed, notMade: notMadeIds },
    });
  }
  return { ok: true, asked };
}
