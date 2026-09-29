import { currentOrgConfig } from "../context";
import { db, unwrap } from "../dal";
import { withDeadline } from "./settlement";
import {
  circleFailureLabel,
  circleHttpStatus,
  defaultCircleClient,
  type CircleClient,
  type CircleClientFactory,
} from "./check";

/** The wallet set every organization's treasury wallets are created in, inside its own Circle entity. */
export const TREASURY_WALLET_SET = "vestiarion-treasury";

const WALLET_CALL_DEADLINE_MS = 15_000;
const SIMULATED_SUFFIX = " (simulated)";

export interface ProvisionResult {
  /** Accounts this run gave a wallet. */
  created: number;
  /** Accounts that already had one, including any another run provisioned while this one was working. */
  skipped: number;
}

/**
 * Circle refused a write, which is the first call that carries the entity
 * secret: the API key was accepted when it was connected, so the secret is
 * what is wrong. The stored credentials stay, and the owner can replace them.
 */
export class EntitySecretRejected extends Error {
  constructor() {
    super("Circle did not accept the entity secret; reconnect with the right one.");
    this.name = "EntitySecretRejected";
  }
}

/**
 * A Circle call that failed for a reason other than the entity secret. The
 * message names the call and its status only: the SDK's own error is not
 * passed on, because its message is Circle's and the Axios error it keeps
 * holds the API key in its request headers.
 */
export class CircleCallFailed extends Error {
  constructor(readonly call: string, readonly status?: number) {
    super(`Circle ${call} failed${status === undefined ? "" : ` with HTTP ${status}`}`);
    this.name = "CircleCallFailed";
  }
}

/**
 * Circle's error codes for an entity secret it will not accept. They come
 * back as 400s, not 401s: a wrong secret is usually "The provided entity
 * secret is invalid" (156013) on a 400. 156016 and 156019 are 403s and would
 * be caught by status anyway; they are listed so the list is the whole story.
 */
const ENTITY_SECRET_CODES: ReadonlySet<number> = new Set([156013, 156016, 156019, 177604, 177605, 177606]);

function isEntitySecretRejection(error: unknown): boolean {
  const status = circleHttpStatus(error);
  if (status === 401 || status === 403) return true;
  const code = (error as { code?: unknown } | null)?.code;
  if (status !== undefined && typeof code === "number" && ENTITY_SECRET_CODES.has(code)) return true;
  // The SDK encrypts the secret before sending anything, decoding it as hex
  // first; a secret that is not hex fails there, locally, with this message.
  return error instanceof Error && !circleHttpStatus(error) && error.message.startsWith("hexToBytes:");
}

/**
 * Runs one Circle call under its 15 s deadline, and turns every failure into
 * an error that carries no secret: `EntitySecretRejected` for a write the
 * secret was refused on, otherwise `CircleCallFailed` with the status only.
 */
export async function circleCall<T>(call: string, work: () => Promise<T>, write: boolean): Promise<T> {
  try {
    return await withDeadline(work(), WALLET_CALL_DEADLINE_MS, `no answer from Circle ${call} within ${WALLET_CALL_DEADLINE_MS} ms`);
  } catch (error) {
    if (write && isEntitySecretRejection(error)) throw new EntitySecretRejected();
    console.warn(`circle: ${call} failed`, circleFailureLabel(error));
    throw new CircleCallFailed(call, circleHttpStatus(error));
  }
}

/**
 * The id of the treasury wallet set, creating it the first time.
 *
 * Two first runs at once can each create a set of that name. That is
 * harmless: a wallet works from either, and later runs take the first found.
 */
export async function treasuryWalletSetId(client: CircleClient): Promise<string> {
  const listed = await circleCall("listWalletSets", () => client.listWalletSets({ pageSize: 50 }), false);
  // The SDK types wallet sets as a union whose end-user variant has no
  // `name`; developer-controlled sets always have one.
  const sets = (listed.data?.walletSets ?? []) as Array<{ id: string; name?: string }>;
  const existing = sets.find((set) => set.name === TREASURY_WALLET_SET)?.id;
  if (existing) return existing;

  const created = await circleCall("createWalletSet", () => client.createWalletSet({ name: TREASURY_WALLET_SET }), true);
  const id = created.data?.walletSet?.id;
  if (!id) throw new CircleCallFailed("createWalletSet");
  return id;
}

/** One new SCA wallet on `chain`, in the given set. */
export async function createScaWallet(
  client: CircleClient,
  walletSetId: string,
  chain: string
): Promise<{ id: string; address: string }> {
  const created = await circleCall(
    "createWallets",
    () => client.createWallets({ blockchains: [chain as never], count: 1, walletSetId, accountType: "SCA" }),
    true
  );
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) throw new CircleCallFailed("createWallets");
  return { id: wallet.id, address: wallet.address };
}

function withoutSimulated(name: string): string {
  return name.endsWith(SIMULATED_SUFFIX) ? name.slice(0, -SIMULATED_SUFFIX.length) : name;
}

/**
 * Gives every treasury account of the organization in scope a Circle
 * developer-controlled wallet on its chain, minted with the organization's
 * own credentials, and drops " (simulated)" from the account's name.
 *
 * Idempotent: an account with a wallet is skipped. Each wallet is written as
 * soon as it exists, so a failure part-way keeps the wallets already made,
 * and the next run creates only the rest.
 *
 * Safe to run twice at once (a double click, two owners). The write only
 * lands on an account that still has no wallet, so each account keeps
 * exactly one; see the comment at the write.
 */
export async function createTreasuryWallets(options: { client?: CircleClientFactory } = {}): Promise<ProvisionResult> {
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new Error("This workspace's Circle credentials are stored but could not be read.");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new Error("This workspace has no Circle credentials.");

  const orgDb = db();
  const accounts = unwrap(
    await orgDb.from("accounts").select("id, name, chain, circle_wallet_id")
  ) as Array<{ id: string; name: string; chain: string; circle_wallet_id: string | null }>;

  const missing = accounts.filter((account) => !account.circle_wallet_id);
  const result: ProvisionResult = { created: 0, skipped: accounts.length - missing.length };
  if (missing.length === 0) return result;

  const client = (options.client ?? defaultCircleClient)({
    apiKey: chain.circleApiKey,
    entitySecret: chain.circleEntitySecret,
  });
  const walletSetId = await treasuryWalletSetId(client);

  for (const account of missing) {
    const wallet = await createScaWallet(client, walletSetId, account.chain);
    const written = unwrap(
      await orgDb
        .from("accounts")
        .update({ circle_wallet_id: wallet.id, address: wallet.address, name: withoutSimulated(account.name) })
        .eq("id", account.id)
        .is("circle_wallet_id", null)
        .select("id")
    ) as Array<{ id: string }>;

    if (written.length === 0) {
      // Another run gave this account a wallet between our read and this
      // write, and the condition kept its wallet. The one just created is
      // left unused in the wallet set; it was never funded, so nothing is lost.
      console.warn("circle: account already provisioned by another run; new wallet left unused", account.id, wallet.id);
      result.skipped += 1;
      continue;
    }
    result.created += 1;
  }
  return result;
}
