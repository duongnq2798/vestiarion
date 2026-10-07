import { defaultCircleClient, type CircleClientFactory } from "./circle/check";
import { createWallet, treasuryWalletSetId, walletIdempotencyKey } from "./circle/provision";
import { currentOrgConfig, currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntry } from "./ledger";
import { addressProvenance, MIRROR } from "./new-payee";
import { readShadowMode } from "./shadow-mode";
import { workspaceNetwork } from "./workspace-network";

/**
 * A mirror address for a payee with none, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S7).
 * The business pays its real supplier as it always has; in shadow mode a payment a person agrees to is made on Arc
 * testnet, and needs somewhere to go. So Vestiarion makes a wallet in the workspace's own Circle wallet set and gives it
 * to the payee as its address: its `mirror_wallet_id` says so. No person typed it, so the new payee check reads it as
 * two parties (`MIRROR` in ./new-payee). Made once per payee (its key is the payee's), written only where the payee
 * still has no address, and recorded as an address change `via: "mirror"`. Never a mirror the ledger does not record:
 * when the entry cannot be written the payee goes back as it was, and a mirror found without its entry (a request that
 * died between the two) is recorded when asked again. Runs inside an organization scope; who may ask for it
 * (`records.write`) is the caller's check.
 */

export type MirrorAddressErrorCode = "not_in_shadow" | "not_found" | "client" | "has_address" | "no_circle" | "credentials_unreadable";

const MESSAGES: Record<MirrorAddressErrorCode, string> = {
  not_in_shadow: "A mirror address is for shadow mode. An owner turns it on in Settings.",
  not_found: "That counterparty is not in this workspace.",
  client: "A client pays you: it needs no address to be paid at.",
  has_address: "This payee has an address already. A mirror address is for a payee with none.",
  no_circle: "Go live on Arc testnet first: a mirror address is a wallet in this workspace's Circle wallets.",
  credentials_unreadable: "This workspace's Circle credentials are stored but could not be read.",
};

export class MirrorAddressError extends Error {
  constructor(readonly code: MirrorAddressErrorCode) {
    super(MESSAGES[code]);
    this.name = "MirrorAddressError";
  }
}

type Payee = {
  id: string;
  name: string;
  role: string;
  address: string | null;
  chain: string | null;
  mirror_wallet_id: string | null;
  address_changed_at: string | null;
  address_confirmed_at: string | null;
};

async function payee(counterpartyId: string): Promise<Payee | null> {
  const rows = unwrap(
    await db()
      .from("counterparties")
      .select("id, name, role, address, chain, mirror_wallet_id, address_changed_at, address_confirmed_at")
      .eq("id", counterpartyId)
      .limit(1)
  ) as Payee[];
  return rows[0] ?? null;
}

type Mirror = { address: string; walletId: string };

/** The entry that makes the mirror the payee's address, as the new payee check reads it. */
function recordMirror(row: Payee, actorId: string, mirror: Mirror): Promise<unknown> {
  return appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "counterparty_address_changed",
    summary: `Gave ${row.name} a mirror address on Arc testnet: a wallet Vestiarion made for it in shadow mode`,
    detail: { by: actorId, counterpartyId: row.id, via: "mirror", from: null, to: mirror.address, walletId: mirror.walletId },
  });
}

/** Whether the ledger gives the payee this mirror: its newest entry setting an address is the mirror's (./new-payee). */
async function mirrorRecorded(counterpartyId: string, address: string): Promise<boolean> {
  const entries = unwrap(
    await db()
      .from("ledger_entries")
      .select("action, detail")
      .eq("domain", "compliance")
      .in("action", ["create_counterparty", "counterparty_address_changed"])
      .eq("detail->>counterpartyId", counterpartyId)
      .order("seq", { ascending: false })
      .limit(1)
  ) as Array<{ action: string; detail: Record<string, unknown> }>;
  return addressProvenance(address, entries).addressBy === MIRROR;
}

/** The mirror a payee has, when its address is the wallet Vestiarion made for it. */
const mirrorOf = (row: Payee | null): Mirror | null => (row?.address && row.mirror_wallet_id ? { address: row.address, walletId: row.mirror_wallet_id } : null);

export async function giveMirrorAddress(
  input: { actorId: string; counterpartyId: string },
  deps: { circle?: CircleClientFactory } = {}
): Promise<Mirror> {
  if (!(await readShadowMode(db()))) throw new MirrorAddressError("not_in_shadow");
  const row = await payee(input.counterpartyId);
  if (!row) throw new MirrorAddressError("not_found");
  const made = mirrorOf(row);
  if (made) {
    // Until it is recorded, the new payee check cannot tell who gave the address (review finding 1).
    if (!(await mirrorRecorded(row.id, made.address))) await recordMirror(row, input.actorId, made);
    return made;
  }
  if (row.role === "client") throw new MirrorAddressError("client");
  if (row.address) throw new MirrorAddressError("has_address");

  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new MirrorAddressError("credentials_unreadable");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new MirrorAddressError("no_circle");
  const client = (deps.circle ?? defaultCircleClient)({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });
  const network = workspaceNetwork();
  // Keyed by the payee, so asking again, or a request that died after Circle made it, finds the same wallet.
  const wallet = await createWallet(client, {
    walletSetId: await treasuryWalletSetId(client),
    chain: network.circleBlockchain,
    accountType: network.walletAccountType,
    idempotencyKey: walletIdempotencyKey(currentOrgId(), `mirror:${row.id}`),
  });

  const written = unwrap(
    await db()
      .from("counterparties")
      // No person typed it, so it waits for no one to confirm it, even where an earlier address was cleared.
      .update({ address: wallet.address, chain: network.circleBlockchain, mirror_wallet_id: wallet.id, address_changed_at: null, address_confirmed_at: null })
      .eq("id", row.id)
      .is("address", null)
      .select("id")
  ) as Array<{ id: string }>;
  if (written.length === 0) {
    // Another tab gave it this mirror a moment before, or a person typed an address meanwhile.
    const now = mirrorOf(await payee(row.id));
    if (now) return now;
    throw new MirrorAddressError("has_address");
  }

  const mirror = { address: wallet.address, walletId: wallet.id };
  try {
    await recordMirror(row, input.actorId, mirror);
  } catch (error) {
    // The payee goes back as it was, only from this mirror, so asking again makes it whole.
    const back = await db()
      .from("counterparties")
      .update({ address: null, chain: row.chain, mirror_wallet_id: null, address_changed_at: row.address_changed_at, address_confirmed_at: row.address_confirmed_at })
      .eq("id", row.id)
      .eq("address", wallet.address)
      .eq("mirror_wallet_id", wallet.id)
      .then(
        (result) => result.error?.message ?? null,
        (failure: unknown) => (failure instanceof Error ? failure.message : "unknown error")
      );
    if (back) console.error("mirror address: not put back after its entry failed", row.id, back);
    throw error;
  }
  return mirror;
}
