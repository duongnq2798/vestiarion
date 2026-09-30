import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * Changing and confirming a counterparty's Arc address (spec
 * 2026-09-30-counterparty-address-edit-design.md). Every export that touches
 * the database runs inside an organization scope.
 *
 * Changing where a payee is paid is the classic payment-redirection fraud,
 * so an edit marks the counterparty `address_changed_at`, and payments to it
 * wait until a person confirms the new address (`address_confirmed_at`
 * later than the change): by approving a payment to it, or with Confirm
 * address on the Counterparties page. A counterparty whose address was set
 * when it was added has neither timestamp and is never held for this.
 *
 * Both writes are compare-and-set updates: the edit on the address it read,
 * the confirmation on the address the person was shown and the change it
 * confirms. So two edits cannot silently overwrite each other, and no one
 * confirms an address they did not see.
 */

/** An Arc (EVM) address: 0x and 40 hex characters. */
export const ARC_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export type CounterpartyAddressErrorCode = "invalid" | "unchanged" | "conflict" | "not_found" | "stale";

const MESSAGES: Record<CounterpartyAddressErrorCode, string> = {
  invalid: "Enter an Arc address: 0x followed by 40 hex characters.",
  unchanged: "That is already this counterparty's address.",
  conflict: "Someone else changed this address a moment ago.",
  not_found: "Counterparty not found.",
  stale: "This counterparty's address changed after this page loaded. Check the new address and try again.",
};

export class CounterpartyAddressError extends Error {
  constructor(readonly code: CounterpartyAddressErrorCode) {
    super(MESSAGES[code]);
    this.name = "CounterpartyAddressError";
  }
}

/** A form's address field: an Arc address, trimmed, or `null` when left empty to clear it. */
export function parseAddressInput(raw: string): { ok: true; address: string | null } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, address: null };
  if (!ARC_ADDRESS.test(trimmed)) return { ok: false, message: MESSAGES.invalid };
  return { ok: true, address: trimmed };
}

/** Whether a person changed the address and no one has confirmed it since. */
export function addressUnconfirmed(changedAt: string | null, confirmedAt: string | null): boolean {
  if (!changedAt) return false;
  if (!confirmedAt) return true;
  return Date.parse(confirmedAt) < Date.parse(changedAt);
}

/** EVM addresses are case-insensitive; the mixed case is only a checksum. */
export function sameAddress(a: string | null, b: string | null): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

interface AddressRow {
  id: string;
  name: string;
  address: string | null;
  address_changed_at: string | null;
  address_confirmed_at: string | null;
}

async function loadCounterparty(counterpartyId: string): Promise<AddressRow> {
  const result = await db()
    .from("counterparties")
    .select("id, name, address, address_changed_at, address_confirmed_at")
    .eq("id", counterpartyId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) throw new CounterpartyAddressError("not_found");
  return result.data as AddressRow;
}

/**
 * Who changed the address: a member (`actorId`), or the payee themselves through
 * a one-time payee link (`payeeLinkId`, spec 2026-09-30-payee-links-design.md).
 * Either way the change is stamped, so payments wait for a member to confirm it.
 */
export type AddressChangeInput = ({ actorId: string } | { payeeLinkId: string }) & {
  counterpartyId: string;
  raw: string;
};

export async function changeCounterpartyAddress(
  input: AddressChangeInput
): Promise<{ name: string; from: string | null; to: string | null }> {
  const parsed = parseAddressInput(input.raw);
  if (!parsed.ok) throw new CounterpartyAddressError("invalid");

  const current = await loadCounterparty(input.counterpartyId);
  if (sameAddress(current.address, parsed.address)) throw new CounterpartyAddressError("unchanged");

  const update = db()
    .from("counterparties")
    .update({ address: parsed.address, address_changed_at: new Date().toISOString() })
    .eq("id", current.id);
  const guarded = current.address === null ? update.is("address", null) : update.eq("address", current.address);
  const rows = unwrap(await guarded.select("id")) as Array<{ id: string }>;
  if (rows.length === 0) throw new CounterpartyAddressError("conflict");

  const byPayee = "payeeLinkId" in input;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "compliance",
    action: "counterparty_address_changed",
    summary: byPayee
      ? `${current.name} entered their own payment address through a payee link; the next payment waits for a person to confirm it`
      : parsed.address === null
        ? `Cleared ${current.name}'s payment address`
        : `Changed ${current.name}'s payment address; the next payment waits for a person to confirm it`,
    detail: {
      ...(byPayee ? { by: null, via: "payee_link", linkId: input.payeeLinkId } : { by: input.actorId }),
      counterpartyId: current.id,
      from: current.address,
      to: parsed.address,
    },
  });

  return { name: current.name, from: current.address, to: parsed.address };
}

/**
 * Confirms the counterparty's changed address, as shown to the person. Returns
 * whether anything was confirmed: `false` when the address needed no
 * confirmation. Refuses with `stale` when the shown address is no longer the
 * counterparty's, or another change landed between the read and the write.
 */
export async function confirmCounterpartyAddress(input: {
  actorId: string;
  counterpartyId: string;
  shownAddress: string;
  via: "approval" | "confirm";
}): Promise<boolean> {
  const current = await loadCounterparty(input.counterpartyId);
  const shown = input.shownAddress.trim();
  if (!sameAddress(current.address, shown === "" ? null : shown)) throw new CounterpartyAddressError("stale");
  if (!addressUnconfirmed(current.address_changed_at, current.address_confirmed_at)) return false;

  const update = db()
    .from("counterparties")
    // Never earlier than the change it confirms, even if this server's clock
    // runs behind the one that stamped the change.
    .update({ address_confirmed_at: new Date(Math.max(Date.now(), Date.parse(current.address_changed_at as string) + 1)).toISOString() })
    .eq("id", current.id)
    .eq("address_changed_at", current.address_changed_at as string);
  const guarded = current.address === null ? update.is("address", null) : update.eq("address", current.address);
  const rows = unwrap(await guarded.select("id")) as Array<{ id: string }>;
  if (rows.length === 0) throw new CounterpartyAddressError("stale");

  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "compliance",
    action: "counterparty_address_confirmed",
    summary: `Confirmed ${current.name}'s new payment address`,
    detail: { by: input.actorId, counterpartyId: current.id, address: current.address, via: input.via },
  });
  return true;
}
