import { currentOrgConfig, currentOrgId, NoOrgScopeError } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import type { LedgerEntryInput } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { encryptSecret, masterKeysFromEnv } from "../secrets";
import { getChainProvider, type ChainProvider } from "../circle";
import { checkCircleApiKey, defaultCircleClient, type CircleClient, type CircleClientFactory } from "../circle/check";
import {
  circleCall,
  CircleCallFailed,
  createTreasuryWallets,
  EntitySecretRejected,
  TREASURY_WALLET_SET,
  type ProvisionResult,
} from "../circle/provision";

type OperatingAccount = { id: string; circle_wallet_id: string | null; address: string | null };

/**
 * Go live (docs/superpowers/specs/2026-09-29-go-live-design.md): an owner
 * connects the workspace's own Circle entity, creates its treasury wallets,
 * and turns it live. The server actions in `src/app/actions/go-live.ts` gate
 * each step on `org.administer`; this module does the work.
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
  /** Both credentials are stored. Whether they can be read is `credentialsUnreadable`. */
  connected: boolean;
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
  | "credentials_unreadable";

const MESSAGES: Record<GoLiveErrorCode, string> = {
  invalid: "Paste both the API key and the entity secret.",
  key_rejected: "Circle did not accept this API key.",
  unreachable: "Could not reach Circle; try again.",
  different_entity: "This workspace is live; its wallets belong to the connected Circle account.",
  not_connected: "Connect Circle first.",
  entity_secret_rejected: "Circle did not accept the entity secret; reconnect with the right one.",
  no_wallets: "Create the treasury wallets first.",
  already_live: "This workspace is already live.",
  credentials_unreadable: "The stored Circle credentials cannot be read; reconnect.",
};

export class GoLiveError extends Error {
  constructor(readonly code: GoLiveErrorCode) {
    super(MESSAGES[code]);
    this.name = "GoLiveError";
  }
}

const SECRET_MAX = 512;
const KIND_ORDER: Record<string, number> = { operating: 0, reserve: 1, chain: 2 };

interface OrgState {
  mode: "sandbox" | "live";
  apiKeyStored: boolean;
  entitySecretStored: boolean;
}

/**
 * The organization's mode, and whether each credential is stored. Only the
 * envelope's master-key id is selected (`->>k`, null when the column is), so
 * not even the ciphertext is read here.
 */
async function orgState(orgId: string): Promise<OrgState> {
  const result = await platformDb()
    .from("orgs")
    .select("mode, api_key_stored:circle_api_key_enc->>k, entity_secret_stored:circle_entity_secret_enc->>k")
    .eq("id", orgId)
    .maybeSingle();
  if (result.error) throw new Error(result.error.message);
  const row = result.data as { mode: "sandbox" | "live"; api_key_stored: string | null; entity_secret_stored: string | null } | null;
  if (!row) throw new Error(`No organization with id ${orgId}`);
  return { mode: row.mode, apiKeyStored: row.api_key_stored !== null, entitySecretStored: row.entity_secret_stored !== null };
}

const isConnected = (state: OrgState) => state.apiKeyStored && state.entitySecretStored;

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
 * reach them: the entity they open reads the operating account's wallet, by
 * its stored id, at its stored address, and that wallet's own set (read by
 * its id, so no listing page can miss it) is the treasury set. Anything short
 * of that is refused as `different_entity`, since payments from the existing
 * wallets would fail under another entity's key; a Circle that did not
 * answer (no answer in 15 s, a 429, a 5xx) is `unreachable` instead, since it
 * says nothing about the entity.
 *
 * The entity secret is not proven here: a read does not use it (R5).
 */
async function proveSameEntity(client: CircleClient, operating: OperatingAccount): Promise<void> {
  const walletId = operating.circle_wallet_id;
  const storedAddress = operating.address;
  if (!walletId || !storedAddress) throw new GoLiveError("different_entity");

  let wallet: { walletSetId?: string; address?: string } | undefined;
  let setName: string | undefined;
  try {
    const read = await circleCall("getWallet", () => client.getWallet({ id: walletId }), false);
    wallet = read.data?.wallet;
    const setId = wallet?.walletSetId;
    if (!setId) throw new GoLiveError("different_entity");
    const set = await circleCall("getWalletSet", () => client.getWalletSet({ id: setId }), false);
    // The SDK types wallet sets as a union whose end-user variant has no
    // `name`; developer-controlled sets always have one.
    setName = (set.data?.walletSet as { name?: string } | undefined)?.name;
  } catch (error) {
    if (error instanceof GoLiveError) throw error;
    // A 404, 400 or 401 for a wallet or set this workspace owns: the key opens some other entity.
    throw new GoLiveError(isTransient(error) ? "unreachable" : "different_entity");
  }

  const sameAddress = wallet?.address?.toLowerCase() === storedAddress.toLowerCase();
  if (setName !== TREASURY_WALLET_SET || !sameAddress) throw new GoLiveError("different_entity");
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
 * Once the operating account has a wallet, in any mode, the new credentials
 * must reach it (`proveSameEntity`, R4): a sandbox holding one entity's
 * wallets cannot be pointed at another entity and then taken live. A live
 * workspace with no operating wallet has nothing to prove them against, and
 * is refused.
 *
 * The update is conditional on the mode read at the start: a workspace that
 * went live meanwhile is asked to try again. A wallet created meanwhile, by a
 * concurrent "Create wallets" under the old credentials, is caught by
 * `goLive`, which proves the stored credentials again.
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

  const keys = masterKeysFromEnv();
  const state = await orgState(input.orgId);
  const factory = input.client ?? defaultCircleClient;

  const verdict = await (input.check ?? checkCircleApiKey)(apiKey, entitySecret, factory);
  if (verdict === "rejected") throw new GoLiveError("key_rejected");
  if (verdict === "unreachable") throw new GoLiveError("unreachable");

  const operating = await inScopeOf(input.orgId, input.actorId, operatingAccount);
  if (operating?.circle_wallet_id) {
    await proveSameEntity(factory({ apiKey, entitySecret }), operating);
  } else if (state.mode === "live") {
    throw new GoLiveError("different_entity");
  }

  const written = unwrap(
    await platformDb()
      .from("orgs")
      .update({
        circle_api_key_enc: encryptSecret(apiKey, { orgId: input.orgId, column: "circle_api_key_enc" }, keys),
        circle_entity_secret_enc: encryptSecret(entitySecret, { orgId: input.orgId, column: "circle_entity_secret_enc" }, keys),
      })
      .eq("id", input.orgId)
      .eq("mode", state.mode)
      .select("id")
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
 */
export async function createWallets(input: {
  orgId: string;
  actorId: string;
  client?: CircleClientFactory;
}): Promise<ProvisionResult> {
  const state = await orgState(input.orgId);
  if (!isConnected(state)) throw new GoLiveError("not_connected");

  return withOrg(
    input.orgId,
    async () => {
      if (currentOrgConfig().chain.credentialsUnreadable) throw new GoLiveError("credentials_unreadable");
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
 * `sandbox`. Zero rows means someone else already did it.
 *
 * Immediately before it, in a fresh scope so the credentials are the ones
 * stored now: they must be stored and readable, the operating account must
 * have a wallet, and those credentials must reach it (`proveSameEntity`,
 * R4) — whatever was connected or created since the last check.
 */
export async function goLive(input: { orgId: string; actorId: string; client?: CircleClientFactory }): Promise<void> {
  const state = await orgState(input.orgId);
  if (state.mode === "live") throw new GoLiveError("already_live");
  if (!isConnected(state)) throw new GoLiveError("not_connected");

  await withOrg(
    input.orgId,
    async () => {
      const chain = currentOrgConfig().chain;
      if (chain.credentialsUnreadable) throw new GoLiveError("credentials_unreadable");
      if (!chain.circleApiKey || !chain.circleEntitySecret) throw new GoLiveError("not_connected");
      const operating = await operatingAccount();
      if (!operating?.circle_wallet_id) throw new GoLiveError("no_wallets");
      const factory = input.client ?? defaultCircleClient;
      await proveSameEntity(factory({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret }), operating);

      const written = unwrap(
        await platformDb().from("orgs").update({ mode: "live" }).eq("id", input.orgId).eq("mode", "sandbox").select("id")
      ) as Array<{ id: string }>;
      if (written.length === 0) throw new GoLiveError("already_live");

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
    const step: GoLiveStep =
      state.mode === "live"
        ? "live"
        : !connected
          ? "connect"
          : !operatingReady || provisioned.length < accounts.length
            ? "wallets"
            : "go_live";

    return {
      step,
      connected,
      wallets,
      liveSince: latest[0]?.ts ?? null,
      credentialsUnreadable: Boolean(currentOrgConfig().chain.credentialsUnreadable),
    };
  });
}
