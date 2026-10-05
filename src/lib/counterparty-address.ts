import { CHECKSUM_MISMATCH, addressProblem, ARC_ADDRESS, NOT_AN_ARC_ADDRESS } from "./address-checksum";
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

/** An Arc (EVM) address: 0x and 40 hex characters (./address-checksum, shared with the console's forms). */
export { ARC_ADDRESS };

export type CounterpartyAddressErrorCode = "invalid" | "checksum" | "unchanged" | "conflict" | "not_found" | "stale";

const MESSAGES: Record<CounterpartyAddressErrorCode, string> = {
  invalid: NOT_AN_ARC_ADDRESS,
  // A mistyped address, told apart from one that is no address (payment safety A3).
  checksum: `${CHECKSUM_MISMATCH} Copy it again from where it came.`,
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
export function parseAddressInput(
  raw: string
): { ok: true; address: string | null } | { ok: false; message: string; /** The shape is right, but its capital letters do not match its checksum (A3). */ checksum: boolean } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, address: null };
  const problem = addressProblem(trimmed);
  return problem ? { ok: false, message: problem, checksum: ARC_ADDRESS.test(trimmed) } : { ok: true, address: trimmed };
}

/** Whether a person changed the address and no one has confirmed it since. */
export function addressUnconfirmed(changedAt: string | null, confirmedAt: string | null): boolean {
  if (!changedAt) return false;
  if (!confirmedAt) return true;
  return Date.parse(confirmedAt) < Date.parse(changedAt);
}

/**
 * Why the agent cannot pay a counterparty yet, or null when it can
 * (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md R5):
 * `unconfirmed` while a changed address waits for a person's confirmation;
 * `no_address` in a live workspace while the payee has not added one, since a
 * live transfer needs somewhere to go. A sandbox simulates a payment to a
 * counterparty with no address, as it always has.
 */
export function payeeNotReady(
  counterparty: { address: string | null; address_changed_at: string | null; address_confirmed_at: string | null },
  live: boolean
): "no_address" | "unconfirmed" | null {
  if (addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at)) return "unconfirmed";
  if (live && !counterparty.address) return "no_address";
  return null;
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
 * Who changed the address: a member (`actorId`), or the payee themselves, through
 * a one-time payee link (`payeeLinkId`, spec 2026-09-30-payee-links-design.md) or
 * with `/payto` on their pull request (`github`, bounties B9). Every way, the change
 * is stamped, so payments wait for a member to confirm it.
 */
export type AddressChangeInput = (
  | { actorId: string }
  | { payeeLinkId: string }
  | { github: { installationId: number; login: string; commentUrl: string } }
) & {
  counterpartyId: string;
  raw: string;
};

export async function changeCounterpartyAddress(
  input: AddressChangeInput
): Promise<{ name: string; from: string | null; to: string | null }> {
  const parsed = parseAddressInput(input.raw);
  if (!parsed.ok) throw new CounterpartyAddressError(parsed.checksum ? "checksum" : "invalid");

  const current = await loadCounterparty(input.counterpartyId);
  if (sameAddress(current.address, parsed.address)) throw new CounterpartyAddressError("unchanged");

  const update = db()
    .from("counterparties")
    .update({ address: parsed.address, address_changed_at: new Date().toISOString() })
    .eq("id", current.id);
  // Guarded on everything read, the change and the confirmation included: a
  // confirmation that lands between this read and this write would otherwise be
  // inherited by the new address (its timestamp later than this change's), and
  // the agent would pay an address no one confirmed. Then this is a conflict.
  const onAddress = current.address === null ? update.is("address", null) : update.eq("address", current.address);
  const onChange = current.address_changed_at === null ? onAddress.is("address_changed_at", null) : onAddress.eq("address_changed_at", current.address_changed_at);
  const guarded =
    current.address_confirmed_at === null ? onChange.is("address_confirmed_at", null) : onChange.eq("address_confirmed_at", current.address_confirmed_at);
  const rows = unwrap(await guarded.select("id")) as Array<{ id: string }>;
  if (rows.length === 0) throw new CounterpartyAddressError("conflict");

  const byPayee = "payeeLinkId" in input;
  const onGitHub = "github" in input ? input.github : null;
  await appendLedgerEntryBestEffort(currentOrgId(), {
    actor: "human",
    domain: "compliance",
    action: "counterparty_address_changed",
    summary: onGitHub
      ? `${onGitHub.login} entered ${current.name}'s address on GitHub; the next payment waits for a person to confirm it`
      : byPayee
      ? `An address was entered through ${current.name}'s payee link; the next payment waits for a person to confirm it`
      : parsed.address === null
        ? `Cleared ${current.name}'s payment address`
        : `Changed ${current.name}'s payment address; the next payment waits for a person to confirm it`,
    detail: {
      ...(onGitHub
        ? { by: null, via: "github", installationId: onGitHub.installationId, login: onGitHub.login, commentUrl: onGitHub.commentUrl }
        : byPayee
          ? { by: null, via: "payee_link", linkId: input.payeeLinkId }
          : { by: "actorId" in input ? input.actorId : null }),
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
