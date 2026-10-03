import crypto from "node:crypto";
import { addressUnconfirmed } from "../counterparty-address";
import { db } from "../dal";
import { paidAcrossChains } from "../payee-chains";
import type { Actor, SurfaceKind } from "./actor";
import { refused, type Refused } from "./outcome";

/**
 * The chat's rules on a person's decision about a payable (Slack design S8–S11), which the payable commands apply for
 * every surface but the console, after the gate and before the console's own approval runs:
 *
 * - the decision answers a card the chat showed, and the card must still be true of the payable: it is still waiting,
 *   and the agent decided it at the same moment as when the card was posted;
 * - Approve and pay goes further: USDC, paid on Arc, within the workspace's limit for the surface, to an address that
 *   is confirmed and is the one the card was posted with. A chat never confirms a changed address (S11); anything else
 *   is approved in the console, which shows the fee, the currency, or the address to confirm.
 *
 * Reads run in the workspace's scope, as every command's do.
 */

/** What a card showed of a payable: when the agent decided it, and its payee's address, hashed. */
export interface ShownCard {
  decidedAt: string | null;
  addressHash: string | null;
}

/** An address as a card carries it: the first 16 hex of its SHA-256, any case; null for none. */
export function addressHash(address: string | null): string | null {
  if (!address) return null;
  return crypto.createHash("sha256").update(address.toLowerCase(), "utf8").digest("hex").slice(0, 16);
}

const NAMES: Record<SurfaceKind, string> = { console: "the console", telegram: "Telegram", slack: "Slack", api: "the API" };

/** A surface by name, as a person reads it in a refusal. */
export function surfaceName(kind: SurfaceKind): string {
  return NAMES[kind];
}

const WAITING = ["held", "flagged", "awaiting_info"];
const STALE = "This payable changed after this message was posted. Open Vestiarion to see it as it is now.";

interface PayableRow {
  amount: string | number;
  currency: string | null;
  status: string;
  direction: string;
  decided_at: string | null;
  counterparties: { address: string | null; chain: string | null; address_changed_at: string | null; address_confirmed_at: string | null } | null;
}

export type ChatCheck = { ok: true; address: string | null } | { ok: false; refusal: Refused };

const no = (refusal: Refused): ChatCheck => ({ ok: false, refusal });

export async function checkChatDecision(
  actor: Actor,
  decision: "approve" | "reject" | "return",
  invoiceId: string,
  card: ShownCard | undefined
): Promise<ChatCheck> {
  const where = surfaceName(actor.surface.kind);
  if (!card) return no(refused("card_required", `Decide this one in Vestiarion: what was sent from ${where} carried no card of it.`));

  const read = await db()
    .from("invoices")
    .select("amount, currency, status, direction, decided_at, counterparties(address, chain, address_changed_at, address_confirmed_at)")
    .eq("id", invoiceId)
    .maybeSingle();
  if (read.error) throw new Error(read.error.message);
  const row = read.data as PayableRow | null;
  if (!row || row.direction !== "payable" || !WAITING.includes(row.status) || (row.decided_at ?? null) !== card.decidedAt) {
    return no(refused("card_stale", STALE));
  }
  const payee = row.counterparties;
  const address = payee?.address ?? null;
  if (decision !== "approve") return { ok: true, address };

  const limit = "decisionsLimitUsdc" in actor.surface ? actor.surface.decisionsLimitUsdc : null;
  if (row.currency === "EURC") return no(refused("open_in_console", "This payable is in EURC. Approve it in Vestiarion."));
  if (paidAcrossChains(payee?.chain)) {
    return no(refused("open_in_console", "Its payee is paid on another chain. Approve it in Vestiarion, which shows the fee."));
  }
  if (limit === null || Number(row.amount) > limit) {
    return no(refused("over_chat_limit", `It is above the ${limit ?? 0} USDC this workspace allows from ${where}. Approve it in Vestiarion.`));
  }
  if (!address) return no(refused("no_address", "Its payee has no address yet. Add one on Counterparties first."));
  if (addressUnconfirmed(payee?.address_changed_at ?? null, payee?.address_confirmed_at ?? null)) {
    return no(refused("address_unconfirmed", "Its payee's address changed and nobody has confirmed it. Confirm it on Counterparties first."));
  }
  if (addressHash(address) !== card.addressHash) return no(refused("card_stale", STALE));
  return { ok: true, address };
}
