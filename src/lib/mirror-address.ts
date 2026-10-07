import { defaultCircleClient, type CircleClientFactory } from "./circle/check";
import { createWallet, treasuryWalletSetId, walletIdempotencyKey } from "./circle/provision";
import { currentOrgConfig, currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { appendLedgerEntry } from "./ledger";
import { readShadowMode } from "./shadow-mode";
import { workspaceNetwork } from "./workspace-network";

/**
 * A mirror address for a payee with none, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S7).
 * The business pays its real supplier as it always has; in shadow mode a payment a person agrees to is made on Arc
 * testnet, and needs somewhere to go. So Vestiarion makes a wallet in the workspace's own Circle wallet set and gives it
 * to the payee as its address: its `mirror_wallet_id` says so. No person typed it, so the new payee check reads it as
 * two parties (`MIRROR` in ./new-payee). Made once per payee (its key is the payee's), written only where the payee
 * still has no address, and recorded as an address change `via: "mirror"`. Runs inside an organization scope; who may
 * ask for it (`records.write`) is the caller's check.
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

type Payee = { id: string; name: string; role: string; address: string | null; mirror_wallet_id: string | null };

async function payee(counterpartyId: string): Promise<Payee | null> {
  const rows = unwrap(await db().from("counterparties").select("id, name, role, address, mirror_wallet_id").eq("id", counterpartyId).limit(1)) as Payee[];
  return rows[0] ?? null;
}

/** The mirror a payee has, when its address is the wallet Vestiarion made for it. */
const mirrorOf = (row: Payee | null) => (row?.address && row.mirror_wallet_id ? { address: row.address, walletId: row.mirror_wallet_id } : null);

export async function giveMirrorAddress(
  input: { actorId: string; counterpartyId: string },
  deps: { circle?: CircleClientFactory } = {}
): Promise<{ address: string; walletId: string }> {
  if (!(await readShadowMode(db()))) throw new MirrorAddressError("not_in_shadow");
  const row = await payee(input.counterpartyId);
  if (!row) throw new MirrorAddressError("not_found");
  const made = mirrorOf(row);
  if (made) return made;
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
      .update({ address: wallet.address, chain: network.circleBlockchain, mirror_wallet_id: wallet.id })
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

  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "counterparty_address_changed",
    summary: `Gave ${row.name} a mirror address on Arc testnet: a wallet Vestiarion made for it in shadow mode`,
    detail: { by: input.actorId, counterpartyId: row.id, via: "mirror", from: null, to: wallet.address, walletId: wallet.id },
  });
  return { address: wallet.address, walletId: wallet.id };
}
