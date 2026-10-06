import type { WalletHost } from "../config";
import crypto from "node:crypto";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { withDeadline } from "./settlement";
import { chainOn } from "../payee-chains";
import { workspaceNetwork } from "../workspace-network";
import {
  circleFailureLabel,
  circleHttpStatus,
  defaultCircleClient,
  type CircleClient,
  type CircleClientFactory,
} from "./check";

/** The wallet set an own-account organization's treasury wallets are created in, inside its own Circle entity. */
export const TREASURY_WALLET_SET = "vestiarion-treasury";

/**
 * The wallet set an organization's treasury wallets belong in (hosted wallets
 * H3). An organization with its own Circle entity has it to itself, so every
 * such organization uses `vestiarion-treasury`. Hosted organizations share the
 * platform's hosted entity, so each has a set of its own, named for its id:
 * the name says which workspace a wallet in that entity belongs to.
 */
export function walletSetName(orgId: string, host: WalletHost | null | undefined): string {
  if (host === "external") return AGENT_WALLET_SET;
  return host === "hosted" ? `vestiarion-${orgId}` : TREASURY_WALLET_SET;
}

/**
 * The set the agent wallets of workspaces paying from their owners' own wallets live in, inside Vestiarion's agent
 * account (wallet treasury W5). Each holds only gas; which workspace it serves is on that workspace's own row.
 */
export const AGENT_WALLET_SET = "vestiarion-agents";

const WALLET_CALL_DEADLINE_MS = 15_000;
const WALLET_SET_PAGE_SIZE = 50;
const WALLET_SET_PAGE_LIMIT = 40;
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
 * The id of the treasury wallet set of the organization in scope, creating it
 * the first time. Its name (`walletSetName`) comes from the same scope
 * configuration as the client's credentials, so a hosted organization's
 * wallets always land in its own set inside the hosted entity.
 *
 * The entity's sets are read a page at a time (R5): the hosted entity holds a
 * set per hosted workspace, far more than one page, and a set missed on a
 * later page would be created again. Each page is its own `circleCall`, under
 * its own deadline, and asks for the sets after the last id of the page
 * before; a short page is the end of the list. After
 * `WALLET_SET_PAGE_LIMIT` full pages it gives up rather than create a set it
 * may already have.
 *
 * Two first runs at once can each create a set of that name. That is
 * harmless: a wallet works from either, and later runs take the first found.
 */
export async function treasuryWalletSetId(client: CircleClient): Promise<string> {
  const name = walletSetName(currentOrgId(), currentOrgConfig().chain.walletHost);
  let pageAfter: string | undefined;
  for (let page = 0; page < WALLET_SET_PAGE_LIMIT; page += 1) {
    const after = pageAfter;
    const listed = await circleCall(
      "listWalletSets",
      () => client.listWalletSets({ pageSize: WALLET_SET_PAGE_SIZE, ...(after ? { pageAfter: after } : {}) }),
      false
    );
    // The SDK types wallet sets as a union whose end-user variant has no
    // `name`; developer-controlled sets always have one.
    const sets = (listed.data?.walletSets ?? []) as Array<{ id: string; name?: string }>;
    const existing = sets.find((set) => set.name === name)?.id;
    if (existing) return existing;
    if (sets.length < WALLET_SET_PAGE_SIZE) return createWalletSet(client, name);
    pageAfter = sets[sets.length - 1].id;
  }
  throw new Error(
    `The workspace's wallet set was not among the first ${WALLET_SET_PAGE_LIMIT * WALLET_SET_PAGE_SIZE} of the Circle entity's wallet sets; none was created`
  );
}

async function createWalletSet(client: CircleClient, name: string): Promise<string> {
  const created = await circleCall("createWalletSet", () => client.createWalletSet({ name }), true);
  const id = created.data?.walletSet?.id;
  if (!id) throw new CircleCallFailed("createWalletSet");
  return id;
}

/**
 * The idempotency key for one account's treasury wallet: the same for every
 * run that provisions that account of that organization, so Circle answers a
 * retried or concurrent `createWallets` with the wallet it already made
 * instead of minting another. Circle requires the version-4 UUID format; this
 * is the first 16 bytes of sha256(`vestiarion-wallet:<orgId>:<accountId>`)
 * with the version nibble set to 4 and the RFC 4122 variant bits set.
 */
export function walletIdempotencyKey(orgId: string, accountId: string): string {
  const bytes = crypto.createHash("sha256").update(`vestiarion-wallet:${orgId}:${accountId}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One new wallet of `accountType` on `chain`, in the given set (mainnet go-live M6). With an `idempotencyKey` Circle
 * returns the wallet an earlier call with that key created; without one the SDK generates a fresh key, so every call
 * mints a wallet.
 */
export async function createWallet(
  client: CircleClient,
  input: { walletSetId: string; chain: string; accountType: "SCA" | "EOA"; idempotencyKey?: string }
): Promise<{ id: string; address: string }> {
  const created = await circleCall(
    "createWallets",
    () =>
      client.createWallets({
        blockchains: [input.chain as never],
        count: 1,
        walletSetId: input.walletSetId,
        accountType: input.accountType,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
    true
  );
  const wallet = created.data?.wallets?.[0];
  if (!wallet?.id || !wallet.address) throw new CircleCallFailed("createWallets");
  return { id: wallet.id, address: wallet.address };
}

/** One new SCA wallet on `chain`: the spending limit's agent wallet is always a smart account. */
export function createScaWallet(client: CircleClient, walletSetId: string, chain: string, idempotencyKey?: string): Promise<{ id: string; address: string }> {
  return createWallet(client, { walletSetId, chain, accountType: "SCA", idempotencyKey });
}

function withoutSimulated(name: string): string {
  return name.endsWith(SIMULATED_SUFFIX) ? name.slice(0, -SIMULATED_SUFFIX.length) : name;
}

/**
 * Gives every treasury account of the organization in scope a Circle
 * developer-controlled wallet on its chain, of its network's account type (a
 * smart account on Arc testnet, an EOA on Arc mainnet: mainnet go-live M6), and
 * only on a chain its network pays on; minted with the credentials its
 * scope holds (its own, or for a hosted organization the platform's hosted
 * pair, in a set of its own: `walletSetName`). It drops " (simulated)" from
 * the account's name, and zeroes
 * its balance: the stored balance was the simulation's, and the new wallet
 * holds nothing until it is funded, so a simulated balance (or a simulated
 * reserve) never carries into live mode. Reconcile reads the real one.
 *
 * Idempotent: an account with a wallet is skipped. Each wallet is written as
 * soon as it exists, so a failure part-way keeps the wallets already made,
 * and the next run creates only the rest.
 *
 * Safe to run twice at once (a double click, two owners). Each account's
 * wallet is requested under the same idempotency key every time
 * (`walletIdempotencyKey`), so Circle hands both runs the same wallet; and
 * the write only lands on an account that still has no wallet, so each
 * account keeps exactly one either way. See the comment at the write.
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

  // Each wallet on a chain the workspace's network pays on, as the network's account type (mainnet go-live M6): an
  // account stored on another network's chain is refused before Circle is asked anything, never given a wallet there.
  const network = workspaceNetwork();
  const chains = new Map(missing.map((account) => [account.id, chainOn(network.id, account.chain).id]));

  const client = (options.client ?? defaultCircleClient)({
    apiKey: chain.circleApiKey,
    entitySecret: chain.circleEntitySecret,
  });
  const walletSetId = await treasuryWalletSetId(client);
  const orgId = currentOrgId();

  for (const account of missing) {
    const wallet = await createWallet(client, {
      walletSetId,
      chain: chains.get(account.id) as string,
      accountType: network.walletAccountType,
      idempotencyKey: walletIdempotencyKey(orgId, account.id),
    });
    const written = unwrap(
      await orgDb
        .from("accounts")
        .update({ circle_wallet_id: wallet.id, address: wallet.address, name: withoutSimulated(account.name), balance: 0 })
        .eq("id", account.id)
        .is("circle_wallet_id", null)
        .select("id")
    ) as Array<{ id: string }>;

    if (written.length === 0) {
      // Another run gave this account a wallet between our read and this
      // write, and the condition kept its wallet (and its balance). Under the
      // shared idempotency key that is normally this same wallet. If Circle's
      // key had expired, the one just created is a second wallet, left unused
      // in its set; it was never funded, so nothing is lost. (Two runs that
      // found different wallet sets send the same key with a different
      // `walletSetId`, which Circle may reject instead: that run then fails
      // with CircleCallFailed, and a retry skips the account, already
      // provisioned by the other run.)
      console.warn("circle: account already provisioned by another run", account.id, wallet.id);
      result.skipped += 1;
      continue;
    }
    result.created += 1;
  }
  return result;
}
