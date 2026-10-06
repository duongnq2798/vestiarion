import { currentOrgConfig, currentOrgId, NoOrgScopeError } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import type { LedgerEntryInput } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { encryptSecret, masterKeysFromEnv } from "../secrets";
import { getChainProvider, type ChainProvider } from "../circle";
import { hasSampleData } from "../sample-data";
import { checkCircleApiKey, defaultCircleClient, type CircleClient, type CircleClientFactory } from "../circle/check";
import { FeatureOffError, NETWORK_IDS, networkOf, networkProfile } from "../network";
import { workspaceNetwork } from "../workspace-network";
import {
  circleCall,
  CircleCallFailed,
  createTreasuryWallets,
  EntitySecretRejected,
  TREASURY_WALLET_SET,
  type ProvisionResult,
} from "../circle/provision";

type OperatingAccount = { id: string; circle_wallet_id: string | null; address: string | null };
type WalletAccount = OperatingAccount & { kind: string };

/**
 * Go live (docs/superpowers/specs/2026-09-29-go-live-design.md): an owner
 * connects the workspace's own Circle entity, creates its treasury wallets,
 * and turns it live. The server actions in `src/app/actions/go-live.ts` gate
 * each step on `org.administer`; this module does the work. Instead of
 * connecting, an owner may choose a hosted testnet wallet
 * (2026-09-30-hosted-wallets-design.md): its wallets are then created in the
 * platform's hosted Circle account, whose pair only `orgConfig` hands out.
 *
 * The API key and entity secret exist in plaintext only between the form and
 * `encryptSecret`, and in the Circle client built from them. They are never
 * logged, returned, put in an error's message, or recorded: every error here
 * is a `GoLiveError` with a fixed message, or one from `provision.ts` that
 * names a Circle call and its status only. The ledger records ids (L8).
 */

export type GoLiveStep = "connect" | "wallets" | "go_live" | "live";

export interface GoLiveStatus {
  step: GoLiveStep;
  /**
   * Both of the workspace's own credentials are stored. Whether they can be
   * read is `credentialsUnreadable`. A hosted workspace stores none: `host` says so.
   */
  connected: boolean;
  /** Whose Circle account holds the wallets: the workspace's own, Vestiarion's hosted one, or not chosen yet (0030). */
  host: "own" | "hosted" | null;
  /** This deployment has the hosted pair, so the hosted choice can be offered. A boolean only (R4). */
  hostedAvailable: boolean;
  /** The accounts that have a Circle wallet, operating first. */
  wallets: Array<{ accountName: string; kind: string; address: string }>;
  /** When `workspace_went_live` was recorded; null before, and for the founding workspace, which predates it. */
  liveSince: string | null;
  credentialsUnreadable: boolean;
}

export type GoLiveErrorCode =
  | "invalid"
  | "key_rejected"
  | "unreachable"
  | "different_entity"
  | "not_connected"
  | "entity_secret_rejected"
  | "no_wallets"
  | "already_live"
  | "credentials_unreadable"
  | "credentials_changed"
  | "no_operating_wallet"
  | "hosted_unavailable"
  | "hosted_not_allowed"
  | "hosted_limit_reached"
  | "hosted_has_wallets"
  | "sample_data_loaded"
  | "key_network"
  | "hosted_network";

const MESSAGES: Record<GoLiveErrorCode, string> = {
  invalid: "Paste both the API key and the entity secret.",
  key_rejected: "Circle did not accept this API key.",
  unreachable: "Could not reach Circle; try again.",
  different_entity: "This workspace's wallets belong to the connected Circle account; use its credentials.",
  not_connected: "Connect Circle first.",
  entity_secret_rejected: "Circle did not accept the entity secret; reconnect with the right one.",
  no_wallets: "Create the treasury wallets first.",
  already_live: "This workspace is already live.",
  credentials_unreadable: "The stored Circle credentials cannot be read; reconnect.",
  credentials_changed: "The Circle credentials changed while going live; try again.",
  no_operating_wallet: "This workspace has no operating wallet; it cannot take new credentials.",
  hosted_unavailable: "Hosted testnet wallets are not available on this deployment.",
  hosted_not_allowed: "A workspace with its own Circle account or wallets cannot switch to a hosted wallet.",
  hosted_limit_reached: "All hosted testnet wallets are taken; connect your own Circle account instead.",
  hosted_has_wallets: "This workspace's wallets are hosted by Vestiarion; start a new workspace to use your own Circle account.",
  sample_data_loaded: "Remove the sample data first. It exists only to try the agent with simulated payments.",
  key_network: "This Circle API key is for Arc mainnet (LIVE_API_KEY). This workspace is on Arc testnet: paste a test key (TEST_API_KEY).",
  hosted_network: "A hosted wallet does not run on this workspace's network yet.",
};

export class GoLiveError extends Error {
  constructor(
    readonly code: GoLiveErrorCode,
    /** Words naming what refused, when the code's own are not enough: a network, by name (network threading P5). */
    message?: string
  ) {
    super(message ?? MESSAGES[code]);
    this.name = "GoLiveError";
  }
}

const SECRET_MAX = 512;
const KIND_ORDER: Record<string, number> = { operating: 0, reserve: 1, chain: 2 };

interface OrgState {
  mode: "sandbox" | "live";
  apiKeyStored: boolean;
  entitySecretStored: boolean;
  /** The stored API key envelope's IV: fresh on every encryption, so it names this one envelope. */
  apiKeyIv: string | null;
  /** `orgs.wallet_host` (0030). */
  walletHost: "own" | "hosted" | null;
  /** `orgs.network` (0075): absent on a row read before it, which is Arc testnet. */
  network: string | null;
}

/**
 * The organization's mode, its wallet host, and whether each credential is
 * stored. Only the envelope's master-key id and IV are selected (`->>k`,
 * `->>iv`, null when the column is), so not even the ciphertext is read here.
 */
async function orgState(orgId: string): Promise<OrgState> {
  const result = await platformDb()
    .from("orgs")
    .select(
      "mode, wallet_host, network, api_key_stored:circle_api_key_enc->>k, entity_secret_stored:circle_entity_secret_enc->>k, api_key_iv:circle_api_key_enc->>iv"
    )
    .eq("id", orgId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as {
    mode: "sandbox" | "live";
    network?: string | null;
    wallet_host?: "own" | "hosted" | null;
    api_key_stored: string | null;
    entity_secret_stored: string | null;
    api_key_iv: string | null;
  } | null;
  if (!row) throw new Error(`No organization with id ${orgId}`);
  return {
    mode: row.mode,
    apiKeyStored: row.api_key_stored !== null,
    entitySecretStored: row.entity_secret_stored !== null,
    apiKeyIv: row.api_key_iv,
    walletHost: row.wallet_host === "hosted" || row.wallet_host === "own" ? row.wallet_host : null,
    network: row.network ?? null,
  };
}

const isConnected = (state: OrgState) => state.apiKeyStored && state.entitySecretStored;
const isHosted = (state: OrgState) => state.walletHost === "hosted";

/** The organization in scope, or null outside every scope. */
function scopedOrgId(): string | null {
  try {
    return currentOrgId();
  } catch (error) {
    if (error instanceof NoOrgScopeError) return null;
    throw error;
  }
}

/**
 * Runs `fn` in the organization's scope: the one a server action already
 * entered (`inOrg`), or a new one for any other caller.
 */
function inScopeOf<T>(orgId: string, actorId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return scopedOrgId() === orgId ? fn() : withOrg(orgId, fn, { userId: actorId });
}

function record(orgId: string, actorId: string, entry: Omit<LedgerEntryInput, "actor" | "domain">): Promise<void> {
  return appendLedgerEntryBestEffort(
    orgId,
    { actor: "human", domain: "system", ...entry },
    scopedOrgId() === orgId ? {} : { enterScope: { userId: actorId } }
  );
}

/** Every account, with its wallet id and address if it has them. */
async function walletAccounts(): Promise<WalletAccount[]> {
  return unwrap(await db().from("accounts").select("id, kind, circle_wallet_id, address")) as WalletAccount[];
}

async function operatingAccount(): Promise<OperatingAccount | null> {
  const result = await db().from("accounts").select("id, circle_wallet_id, address").eq("kind", "operating").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  return result.data as OperatingAccount | null;
}

/** No answer, a rate limit or a server error says nothing about which entity the key belongs to. */
function isTransient(error: unknown): boolean {
  if (!(error instanceof CircleCallFailed)) return false;
  return error.status === undefined || error.status === 429 || error.status >= 500;
}

/**
 * Review Focus 5 and R4: the workspace's wallets belong to the Circle entity
 * that created them. Credentials are accepted for those wallets only if they
 * reach every one of them: for each account with a wallet, the entity they
 * open reads that wallet, by its stored id, at its stored address; and each
 * wallet's own set (read by its id, so no listing page can miss it) is the
 * treasury set. Anything short of that is refused as `different_entity`,
 * since payments from the existing wallets would fail under another entity's
 * key; a Circle that did not answer (no answer in 15 s, a 429, a 5xx) is
 * `unreachable` instead, since it says nothing about the entity.
 *
 * The entity secret is not proven here: a read does not use it (R5).
 */
async function proveSameEntity(client: CircleClient, accounts: WalletAccount[]): Promise<void> {
  try {
    const setIds = new Set<string>();
    for (const account of accounts) {
      const walletId = account.circle_wallet_id;
      const storedAddress = account.address;
      if (!walletId || !storedAddress) throw new GoLiveError("different_entity");
      const read = await circleCall("getWallet", () => client.getWallet({ id: walletId }), false);
      const wallet = read.data?.wallet as { walletSetId?: string; address?: string } | undefined;
      if (!wallet?.walletSetId || wallet.address?.toLowerCase() !== storedAddress.toLowerCase()) {
        throw new GoLiveError("different_entity");
      }
      setIds.add(wallet.walletSetId);
    }
    for (const setId of setIds) {
      const set = await circleCall("getWalletSet", () => client.getWalletSet({ id: setId }), false);
      // The SDK types wallet sets as a union whose end-user variant has no
      // `name`; developer-controlled sets always have one.
      if ((set.data?.walletSet as { name?: string } | undefined)?.name !== TREASURY_WALLET_SET) {
        throw new GoLiveError("different_entity");
      }
    }
  } catch (error) {
    if (error instanceof GoLiveError) throw error;
    // A 404, 400 or 401 for a wallet or set this workspace owns: the key opens some other entity.
    throw new GoLiveError(isTransient(error) ? "unreachable" : "different_entity");
  }
}

function validSecret(value: string): boolean {
  // Code points, as the form's maxLength and Postgres count them.
  const length = [...value].length;
  return length > 0 && length <= SECRET_MAX;
}

/**
 * Step 1: checks the API key with Circle, and stores both credentials,
 * encrypted and bound to the organization and their column, in one update.
 *
 * Once any account has a wallet, in any mode, the new credentials must reach
 * every such wallet (`proveSameEntity`, R4): a sandbox holding one entity's
 * wallets cannot be pointed at another entity and then taken live. A live
 * workspace with no operating wallet is refused (`no_operating_wallet`): it
 * cannot pay, and has no wallet to prove new credentials against.
 *
 * The update is conditional on the mode and the wallet host read at the
 * start: a workspace that went live, or chose a hosted wallet, meanwhile is
 * asked to try again. A wallet created meanwhile, by a
 * concurrent "Create wallets" under the old credentials, is caught by
 * `goLive`, which proves the stored credentials again.
 *
 * The same update marks the workspace `wallet_host = 'own'` (hosted wallets
 * H4). A hosted workspace may switch to its own account this way only while
 * it has no wallets: its wallets live in the platform's hosted entity, which
 * no credentials of its own can reach, so once one exists it is refused
 * (`hosted_has_wallets`) before Circle is asked anything.
 */
export async function connectCircle(input: {
  orgId: string;
  actorId: string;
  apiKey: string;
  entitySecret: string;
  check?: typeof checkCircleApiKey;
  client?: CircleClientFactory;
}): Promise<void> {
  const apiKey = input.apiKey.trim();
  const entitySecret = input.entitySecret.trim();
  if (!validSecret(apiKey) || !validSecret(entitySecret)) throw new GoLiveError("invalid");
  // A sample counterparty has no address: with credentials stored, the agent would try to pay it for real (sample-data S1).
  if (await inScopeOf(input.orgId, input.actorId, hasSampleData)) throw new GoLiveError("sample_data_loaded");

  const keys = masterKeysFromEnv();
  const state = await orgState(input.orgId);
  const factory = input.client ?? defaultCircleClient;

  // The key is for the workspace's network (network foundation N5): a key whose prefix names another network is
  // refused before Circle is asked or anything is stored, so a mainnet key never reaches a testnet workspace.
  const network = networkOf(state.network);
  if (NETWORK_IDS.some((other) => other !== network && apiKey.startsWith(networkProfile(other).circleKeyPrefix))) {
    throw new GoLiveError("key_network");
  }

  if (isHosted(state)) {
    const hostedAccounts = await inScopeOf(input.orgId, input.actorId, walletAccounts);
    if (hostedAccounts.some((account) => account.circle_wallet_id)) throw new GoLiveError("hosted_has_wallets");
  }

  const verdict = await (input.check ?? checkCircleApiKey)(apiKey, entitySecret, factory);
  if (verdict === "rejected") throw new GoLiveError("key_rejected");
  if (verdict === "unreachable") throw new GoLiveError("unreachable");

  const accounts = await inScopeOf(input.orgId, input.actorId, walletAccounts);
  const operating = accounts.find((account) => account.kind === "operating");
  if (state.mode === "live" && !operating?.circle_wallet_id) throw new GoLiveError("no_operating_wallet");
  const provisioned = accounts.filter((account) => account.circle_wallet_id);
  if (provisioned.length > 0) {
    // A hosted wallet created while the key was being checked: the same refusal, not a proof that could only fail.
    if (isHosted(state)) throw new GoLiveError("hosted_has_wallets");
    await proveSameEntity(factory({ apiKey, entitySecret }), provisioned);
  }

  const update = platformDb()
    .from("orgs")
    .update({
      circle_api_key_enc: encryptSecret(apiKey, { orgId: input.orgId, column: "circle_api_key_enc" }, keys),
      circle_entity_secret_enc: encryptSecret(entitySecret, { orgId: input.orgId, column: "circle_entity_secret_enc" }, keys),
      wallet_host: "own",
    })
    .eq("id", input.orgId)
    .eq("mode", state.mode);
  // Bound to the host read at the start too: a hosted choice landing meanwhile is not overwritten.
  const written = unwrap(
    await (state.walletHost === null ? update.is("wallet_host", null) : update.eq("wallet_host", state.walletHost)).select("id")
  ) as Array<{ id: string }>;
  if (written.length === 0) throw new Error("the workspace changed while Circle was being connected; nothing was stored");

  const reconnected = state.apiKeyStored || state.entitySecretStored;
  await record(input.orgId, input.actorId, {
    action: reconnected ? "circle_reconnected" : "circle_connected",
    summary: reconnected ? "Circle credentials were replaced" : "Circle was connected",
    detail: { by: input.actorId },
  });
}

/**
 * Step 2: a Circle wallet for every account that has none, in the
 * organization's own entity (`createTreasuryWallets`).
 *
 * Fill-only, in any mode (R6): an account that has a wallet keeps it, since
 * the write is conditional on `circle_wallet_id is null`. A live workspace
 * can so gain a wallet for an account that lacks one; one whose accounts all
 * have wallets, like the founding workspace, makes no Circle call at all.
 *
 * It always enters a fresh scope, so the configuration it pays with is
 * decrypted from the row as it is now — credentials connected a moment ago,
 * even in a scope entered before they were, are the ones used.
 *
 * A hosted workspace stores no credentials: its scope holds the platform's
 * hosted pair (`orgConfig`, H1), and provisioning puts its wallets in a set of
 * its own (H3). On a deployment without that pair it is refused
 * (`hosted_unavailable`), never simulated.
 */
export async function createWallets(input: {
  orgId: string;
  actorId: string;
  client?: CircleClientFactory;
}): Promise<ProvisionResult> {
  const state = await orgState(input.orgId);
  if (!isHosted(state) && !isConnected(state)) throw new GoLiveError("not_connected");

  return withOrg(
    input.orgId,
    async () => {
      const chain = currentOrgConfig().chain;
      // Read as its own account, now hosted: never mint with a pair the check above did not see.
      if (!isHosted(state) && chain.walletHost === "hosted") throw new GoLiveError("credentials_changed");
      if (chain.credentialsUnreadable) {
        throw new GoLiveError(chain.walletHost === "hosted" ? "hosted_unavailable" : "credentials_unreadable");
      }
      let result: ProvisionResult;
      try {
        result = await createTreasuryWallets({ client: input.client });
      } catch (error) {
        if (error instanceof EntitySecretRejected) throw new GoLiveError("entity_secret_rejected");
        throw error;
      }
      if (result.created > 0) {
        await record(input.orgId, input.actorId, {
          action: "treasury_wallets_created",
          summary: "Treasury wallets were created",
          detail: { by: input.actorId, accounts: result.created },
        });
      }
      return result;
    },
    { userId: input.actorId }
  );
}

/**
 * Step 3 (L6): one conditional update, `mode = 'live'` where it is still
 * `sandbox` and the API key envelope is still the one proven.
 *
 * Immediately before it, in a fresh scope so the credentials are the ones
 * stored now: they must be stored and readable, the operating account must
 * have a wallet, and those credentials must reach every account's wallet
 * (`proveSameEntity`, R4) — whatever was connected or created since the last
 * check.
 *
 * The envelope's IV is read before the scope decrypts the row, and the
 * update requires it unchanged: a connect landing anywhere after that read
 * re-encrypts both credentials in one update, so the update matches no row
 * and the owner is told the credentials changed (`credentials_changed`)
 * rather than going live on credentials nobody proved. Zero rows with the
 * workspace already live means someone else went live first.
 *
 * A hosted workspace (hosted wallets H3) is not proven: its entity is the
 * platform's by construction, and its wallets are its own `accounts` rows.
 * The scope must hold the hosted pair (`hosted_unavailable` otherwise) and the
 * operating account a wallet; the update is then bound to `wallet_host =
 * 'hosted'` instead of an envelope it does not have, so a workspace that
 * switched to its own account meanwhile does not go live on it unproven.
 */
export async function goLive(input: { orgId: string; actorId: string; client?: CircleClientFactory }): Promise<void> {
  const state = await orgState(input.orgId);
  if (state.mode === "live") throw new GoLiveError("already_live");
  const hosted = isHosted(state);
  if (!hosted && !isConnected(state)) throw new GoLiveError("not_connected");

  await withOrg(
    input.orgId,
    async () => {
      const chain = currentOrgConfig().chain;
      // The host changed between the state read and this scope, either way: the checks below would be the wrong ones.
      if (hosted !== (chain.walletHost === "hosted")) throw new GoLiveError("credentials_changed");
      if (chain.credentialsUnreadable) throw new GoLiveError(hosted ? "hosted_unavailable" : "credentials_unreadable");
      if (!chain.circleApiKey || !chain.circleEntitySecret) throw new GoLiveError("not_connected");
      const accounts = await walletAccounts();
      if (!accounts.find((account) => account.kind === "operating")?.circle_wallet_id) throw new GoLiveError("no_wallets");
      if (!hosted) {
        const factory = input.client ?? defaultCircleClient;
        await proveSameEntity(
          factory({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret }),
          accounts.filter((account) => account.circle_wallet_id)
        );
      }

      const update = platformDb().from("orgs").update({ mode: "live" }).eq("id", input.orgId).eq("mode", "sandbox");
      const written = unwrap(
        await (hosted
          ? update.eq("wallet_host", "hosted")
          : update.eq("circle_api_key_enc->>iv", state.apiKeyIv as string)
        ).select("id")
      ) as Array<{ id: string }>;
      if (written.length === 0) {
        throw new GoLiveError((await orgState(input.orgId)).mode === "live" ? "already_live" : "credentials_changed");
      }

      await record(input.orgId, input.actorId, {
        action: "workspace_went_live",
        summary: "The workspace went live",
        detail: { by: input.actorId },
      });
    },
    { userId: input.actorId }
  );
}

/**
 * The operating wallet's USDC balance on chain, for the Go live step, read in
 * the organization's scope already entered. The provider's `getBalance` runs
 * Circle's read under its own deadline. Only a live provider is asked: a
 * simulated one would answer with the stored, simulated balance, which is not
 * what the owner is funding.
 */
export async function operatingBalance(provider?: Pick<ChainProvider, "mode" | "getBalance">): Promise<number> {
  const operating = await operatingAccount();
  if (!operating?.circle_wallet_id) throw new GoLiveError("no_wallets");
  const chain = provider ?? getChainProvider();
  if (chain.mode !== "live") throw new GoLiveError("not_connected");
  const snapshot = await chain.getBalance(operating.id);
  return snapshot.balance;
}

/** What the Go live panel shows: the step the workspace is on, and nothing secret. */
export async function goLiveStatus(orgId: string): Promise<GoLiveStatus> {
  const state = await orgState(orgId);
  return inScopeOf(orgId, undefined, async () => {
    const accounts = unwrap(
      await db().from("accounts").select("name, kind, address, circle_wallet_id")
    ) as Array<{ name: string; kind: string; address: string | null; circle_wallet_id: string | null }>;
    const latest = unwrap(
      await db()
        .from("ledger_entries")
        .select("ts")
        .eq("action", "workspace_went_live")
        .order("seq", { ascending: false })
        .limit(1)
    ) as Array<{ ts: string }>;

    const provisioned = accounts.filter((account) => account.circle_wallet_id && account.address);
    const wallets = provisioned
      .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name))
      .map((account) => ({ accountName: account.name, kind: account.kind, address: account.address as string }));

    const connected = isConnected(state);
    const operatingReady = provisioned.some((account) => account.kind === "operating");
    // Choosing the hosted wallet is a hosted workspace's connect step.
    const step: GoLiveStep =
      state.mode === "live"
        ? "live"
        : !connected && !isHosted(state)
          ? "connect"
          : !operatingReady || provisioned.length < accounts.length
            ? "wallets"
            : "go_live";

    const chain = currentOrgConfig().chain;
    return {
      step,
      connected,
      host: state.walletHost,
      // Offered only where the workspace's network has hosted wallets (network threading P5).
      hostedAvailable: Boolean(chain.hostedAvailable) && workspaceNetwork().hostedWallets,
      wallets,
      liveSince: latest[0]?.ts ?? null,
      credentialsUnreadable: Boolean(chain.credentialsUnreadable),
    };
  });
}

/**
 * The connect step's other choice (hosted wallets H4, H5): the workspace's
 * wallets will be created in the platform's hosted Circle testnet account.
 *
 * Offered only where the deployment has the hosted pair (`hosted_unavailable`
 * otherwise). `choose_hosted_wallet` (0030) does the rest under one advisory
 * lock: it refuses a workspace holding Circle credentials or any wallet
 * (`hosted_not_allowed`), holds the platform to `HOSTED_WORKSPACE_LIMIT`
 * hosted workspaces (`hosted_limit_reached`), and leaves one already hosted
 * as it is. It answers whether it marked the workspace hosted, and only then
 * is `hosted_wallet_chosen` recorded, with ids only: choosing again, or a
 * second owner choosing at the same moment, records nothing.
 */
export async function chooseHostedWallet(input: { orgId: string; actorId: string }): Promise<void> {
  const platform = await inScopeOf(input.orgId, input.actorId, async () => {
    const config = currentOrgConfig();
    return { available: Boolean(config.chain.hostedAvailable), limit: config.hostedWorkspaceLimit, network: workspaceNetwork() };
  });
  // Hosted wallets are the platform's testnet account's: a network without them refuses by name (network threading P5).
  if (!platform.network.hostedWallets) throw new GoLiveError("hosted_network", new FeatureOffError("A hosted wallet", platform.network).message);
  if (!platform.available) throw new GoLiveError("hosted_unavailable");
  if (await inScopeOf(input.orgId, input.actorId, hasSampleData)) throw new GoLiveError("sample_data_loaded");

  const { data: changed, error } = await platformDb().rpc("choose_hosted_wallet", {
    p_org_id: input.orgId,
    p_limit: platform.limit,
  });
  if (error) {
    if (error.message.includes("hosted_not_allowed")) throw new GoLiveError("hosted_not_allowed");
    if (error.message.includes("hosted_limit_reached")) throw new GoLiveError("hosted_limit_reached");
    throw new Error(error.message);
  }
  if (changed !== true) return;

  await record(input.orgId, input.actorId, {
    action: "hosted_wallet_chosen",
    summary: "A hosted testnet wallet was chosen",
    detail: { by: input.actorId },
  });
}
