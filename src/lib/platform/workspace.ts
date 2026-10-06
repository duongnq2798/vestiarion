import crypto from "node:crypto";
import { isValidSlug } from "../auth/org-paths";
import { db, platformDb } from "../dal";
import { requireOrgScopeSettings, withOrg } from "../dal/scope";
import { appendLedgerEntry } from "../ledger";
import { ledgerKeyId } from "../ledger-keys";
import { encryptSecret, masterKeysFromEnv } from "../secrets";
import { currentConfig } from "../context";
import { MAINNET_OFF, MAINNET_STARTING_TWO_APPROVALS } from "../mainnet";
import type { Network } from "../network";
import { homeChain } from "../payee-chains";
import { workspaceNetwork } from "../workspace-network";

/**
 * Self-serve workspaces: a person names one, and gets a sandbox organization
 * with its own ledger key, its starting accounts, and themselves as owner. On
 * Arc testnet it starts with two simulated accounts; on Arc mainnet, which only
 * the onboarding action's allowlist reaches, with one empty operating account
 * and a tight spending limit for the agent (mainnet go-live M2, M9).
 */

const MAX_NAME = 80;
const MAX_BASE_SLUG = 36;
const ATTEMPTS = 5;

/**
 * The accounts a new workspace starts with, on its network's own chain (network threading P4): Arc testnet's two
 * simulated ones, or Arc mainnet's one operating account, empty, with no reserve, since USYC does not run there and a
 * mainnet workspace never simulates (mainnet go-live M2).
 */
function startingAccounts(network: Network) {
  const chain = homeChain(network).id;
  if (network === "arc-mainnet") return [{ name: "Operating", kind: "operating", chain, balance: 0 }];
  return [
    { name: "Operating (simulated)", kind: "operating", chain, balance: 10000 },
    { name: "Reserve (simulated)", kind: "reserve", chain, balance: 0 },
  ];
}

/** The agent's spending limit a mainnet workspace starts with (mainnet go-live M9): tight, and a figure always stays. */
export const MAINNET_STARTING_BUDGET = { dailyUsdc: 50, weeklyUsdc: 150 } as const;

/**
 * The figure above which a payment on a mainnet workspace needs two people, from the start (mainnet limits L1): the
 * platform's default, written at creation, so it needs no second approver to set; on Arc mainnet it is never off (L2).
 */
export { MAINNET_STARTING_TWO_APPROVALS };

/** `create_org` refuses a fourth workspace for the same person (migration 0020). */
export class WorkspaceLimitError extends Error {
  constructor() {
    super("You already have 3 workspaces, the most one person can create.");
    this.name = "WorkspaceLimitError";
  }
}

/**
 * A readable address from a workspace name. Accented letters fold to their
 * base letter; anything else outside `a-z0-9` becomes a hyphen. The base is
 * kept to 36 characters so a four-character suffix still fits the 40 the
 * `orgs.slug` check allows. A name with too little Latin in it to spell an
 * address gets a generic one, which the suffixing below makes unique.
 */
export function slugFromName(name: string): string {
  const trimHyphens = (value: string) => value.replace(/^-+|-+$/g, "");
  const slug = trimHyphens(
    trimHyphens(
      name
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
    ).slice(0, MAX_BASE_SLUG)
  );
  return slug.length >= 3 && isValidSlug(slug) ? slug : "workspace";
}

function isSlugClash(error: { code?: string; message: string; details?: string | null }): boolean {
  return error.code === "23505" && `${error.message} ${error.details ?? ""}`.includes("orgs_slug_key");
}

export async function createWorkspace(input: {
  userId: string;
  name: string;
  /** Arc testnet unless the caller, which checked the person against the allowlist, asks for Arc mainnet (M2). */
  network?: Network;
  random?: () => string;
}): Promise<{ orgId: string; slug: string }> {
  const { userId, network = "arc-testnet", random = () => crypto.randomBytes(2).toString("hex") } = input;
  const name = input.name.trim();
  if (name.length < 1 || name.length > MAX_NAME) {
    throw new Error(`A workspace name must be 1 to ${MAX_NAME} characters.`);
  }
  // Never on Arc mainnet while the deployment has it off, whoever asks (mainnet go-live M1): refused before anything.
  if (network === "arc-mainnet" && !currentConfig().mainnetEnabled) throw new Error(MAINNET_OFF);
  // A deployment that could not enter the new organization, or could not
  // store its ledger key, must fail here, before anything is created: an
  // organization it cannot set up would still count against the person's limit.
  requireOrgScopeSettings();
  const keys = masterKeysFromEnv();

  const base = slugFromName(name);
  let created: { orgId: string; slug: string; publicKey: crypto.KeyObject } | undefined;
  for (let attempt = 0; attempt < ATTEMPTS && !created; attempt++) {
    const slug = attempt === 0 ? base : `${base.slice(0, MAX_BASE_SLUG - 1).replace(/-+$/, "")}-${random()}`;

    // A courtesy that saves generating a key for an address already taken.
    // The unique constraint `create_org` meets is what actually decides, since
    // two people can pass this check with the same slug at the same moment.
    const taken = await platformDb().from("orgs").select("id").eq("slug", slug).maybeSingle();
    if (taken.error) throw new Error(taken.error.message);
    if (taken.data) continue;

    // The envelope is bound to the organization's id, so every attempt gets
    // its own id and its own key sealed to it.
    const orgId = crypto.randomUUID();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const envelope = encryptSecret(pem, { orgId, column: "ledger_signing_key_enc" }, keys);

    const { error } = await platformDb().rpc("create_org", {
      p_org_id: orgId,
      p_user_id: userId,
      p_name: name,
      p_slug: slug,
      p_ledger_key_enc: envelope,
    });
    if (error) {
      if (error.message.includes("org_limit_reached")) throw new WorkspaceLimitError();
      if (isSlugClash(error)) continue;
      throw new Error(error.message);
    }
    created = { orgId, slug, publicKey };
  }
  if (!created) throw new Error("Could not find a free address for this workspace; try a different name.");

  const { orgId, slug, publicKey } = created;
  try {
    // The network is chosen here, before the first account exists: once one does, it never changes (0078, M3). The
    // scope below then reads it from the row, as every later scope does.
    if (network !== "arc-testnet") {
      const set = await platformDb().from("orgs").update({ network }).eq("id", orgId).select("id");
      if (set.error) throw new Error(set.error.message);
      if (!set.data || set.data.length === 0) throw new Error("the new workspace's network was not set");
    }
    await withOrg(
      orgId,
      async () => {
        const own = workspaceNetwork().id;
        const inserted = await db().from("accounts").insert(startingAccounts(own));
        if (inserted.error) throw new Error(inserted.error.message);
        if (own === "arc-mainnet") {
          const budget = await db().from("agent_budgets").insert({
            daily_usdc: MAINNET_STARTING_BUDGET.dailyUsdc,
            weekly_usdc: MAINNET_STARTING_BUDGET.weeklyUsdc,
            updated_by: userId,
          });
          if (budget.error) throw new Error(budget.error.message);
          const policy = await db().from("approval_policies").insert({ two_approvals_above: MAINNET_STARTING_TWO_APPROVALS, updated_by: userId });
          if (policy.error) throw new Error(policy.error.message);
        }
        await appendLedgerEntry({
          actor: "human",
          domain: "system",
          action: "org_created",
          summary: `Workspace created: ${name}`,
          detail: {
            by: userId,
            slug,
            mode: "sandbox",
            network: own,
            // Every figure a mainnet workspace starts with, on record (mainnet limits L4).
            ...(own === "arc-mainnet"
              ? { startingLimits: { dailyUsdc: MAINNET_STARTING_BUDGET.dailyUsdc, weeklyUsdc: MAINNET_STARTING_BUDGET.weeklyUsdc, twoApprovalsAbove: MAINNET_STARTING_TWO_APPROVALS } }
              : {}),
            ledgerKeyId: ledgerKeyId(publicKey),
          },
        });
      },
      { userId }
    );
  } catch (error) {
    await rollBack(orgId, userId);
    throw error;
  }

  return { orgId, slug };
}

/**
 * Undoes a `create_org` whose setup failed, so a half-built organization does
 * not count against the person's limit. Best effort throughout: the error
 * worth reporting is the one that caused this, not one met cleaning up.
 *
 * The accounts go first, through the tenant role, because they restrict the
 * organization's delete and only that role may remove them. Memberships
 * cascade with the organization. If the first ledger entry did commit, its
 * restrict refuses the delete, and that is right: a chain once started stays.
 */
async function rollBack(orgId: string, userId: string): Promise<void> {
  try {
    await withOrg(orgId, async () => { await db().from("accounts").delete(); }, { userId });
  } catch {
    // The organization's delete below fails on its own if accounts remain.
  }
  try {
    await platformDb().from("orgs").delete().eq("id", orgId);
  } catch {
    // Left for an operator; the original error still reaches the caller.
  }
  console.error("workspace setup failed; rolled back", orgId);
}
