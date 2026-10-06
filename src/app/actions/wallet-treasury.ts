"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import {
  chooseWalletTreasury,
  createAgentWallet,
  prepareAgentGas,
  prepareApproval,
  prepareDeployment,
  proofMessage,
  recordApproval,
  recordDeployment,
  WalletTreasuryError,
  type PreparedTransaction,
} from "@/lib/treasury/wallet-treasury";

/**
 * The setup of a workspace that pays from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W3, W5–W10), owner only. The page calls these between the owner's wallet's own steps: a transaction to
 * send comes back from a `prepare…` action, its hash goes back to a `record…` one, which reads the chain. Nothing
 * secret is taken or returned; a refusal comes back in its own words, anything else as one fixed sentence.
 */

export interface WalletTreasuryActionResult {
  ok: boolean;
  message: string;
}

const GENERIC = "Something went wrong; try again.";

function failed(action: string, error: unknown): WalletTreasuryActionResult {
  if (error instanceof WalletTreasuryError) return { ok: false, message: error.message };
  console.error(`wallet-treasury: ${action} failed`);
  return { ok: false, message: GENERIC };
}

/** The person and the workspace an authorized call acts for. */
type Authorized = Extract<Awaited<ReturnType<typeof authorize>>, { ok: true }>;
const actor = (auth: Authorized) => ({ orgId: auth.membership.orgId, actorId: auth.user.id, actorEmail: auth.user.email ?? null });

/** The message the owner's wallet signs to prove it is theirs (W3). */
export async function proofMessageAction(orgSlug: string, address: string): Promise<WalletTreasuryActionResult & { text: string | null }> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, text: null };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", text: await proofMessage({ orgId: auth.membership.orgId, address }) };
    } catch (error) {
      return { ...failed("proofMessageAction", error), text: null };
    }
  });
}

/** The owner's wallet, proven by their signature, becomes the workspace's treasury (W1, W3). */
export async function chooseWalletTreasuryAction(
  orgSlug: string,
  proof: { address: string; message: string; signature: string }
): Promise<WalletTreasuryActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await chooseWalletTreasury({ ...actor(auth), ...proof });
      revalidateOrgPages();
      return { ok: true, message: "Your wallet is this workspace's treasury. Create the agent's wallet next." };
    } catch (error) {
      return failed("chooseWalletTreasuryAction", error);
    }
  });
}

/** Vestiarion creates the agent's wallet, which pays through the contract and holds only gas (W5). */
export async function createAgentWalletAction(orgSlug: string): Promise<WalletTreasuryActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await createAgentWallet(actor(auth));
      revalidateOrgPages();
      return { ok: true, message: "The agent's wallet is created. Deploy the contract from your wallet next." };
    } catch (error) {
      return failed("createAgentWalletAction", error);
    }
  });
}

export interface PreparedActionResult extends WalletTreasuryActionResult {
  transaction: PreparedTransaction | null;
}

export interface RecordActionResult extends WalletTreasuryActionResult {
  state: "pending" | "verified" | null;
  /** The chain could not be read just now: the transaction may still be recorded, so the page asks again. */
  chainUnreadable?: true;
}

/** A recording step's refusal, saying when it was only a moment the chain could not be read. */
function recordFailed(action: string, error: unknown): RecordActionResult {
  const unreadable = error instanceof WalletTreasuryError && error.code === "chain_unreadable";
  return { ...failed(action, error), state: null, ...(unreadable ? { chainUnreadable: true as const } : {}) };
}

/** The deployment for the owner's wallet to send (W6). */
export async function prepareDeploymentAction(orgSlug: string, figures: { dailyUsdc: number | null; weeklyUsdc: number | null }): Promise<PreparedActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, transaction: null };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", transaction: await prepareDeployment({ orgId: auth.membership.orgId, ...figures }) };
    } catch (error) {
      return { ...failed("prepareDeploymentAction", error), transaction: null };
    }
  });
}

/** The deployment the owner's wallet sent, recorded once the chain shows it (W8). */
export async function recordDeploymentAction(orgSlug: string, txHash: string): Promise<RecordActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, state: null };
  return inOrg(auth, async () => {
    try {
      const state = await recordDeployment({ orgId: auth.membership.orgId, actorId: auth.user.id, txHash });
      if (state === "verified") revalidateOrgPages();
      return { ok: true, message: "", state };
    } catch (error) {
      return recordFailed("recordDeploymentAction", error);
    }
  });
}

/** The approval for the owner's wallet to send on USDC (W9). */
export async function prepareApprovalAction(orgSlug: string, input: { capUsdc: number | null }): Promise<PreparedActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, transaction: null };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", transaction: await prepareApproval({ orgId: auth.membership.orgId, capUsdc: input.capUsdc }) };
    } catch (error) {
      return { ...failed("prepareApprovalAction", error), transaction: null };
    }
  });
}

/** The approval the owner's wallet sent, recorded once the chain shows it (W9). */
export async function recordApprovalAction(orgSlug: string, txHash: string): Promise<RecordActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, state: null };
  return inOrg(auth, async () => {
    try {
      const state = await recordApproval({ orgId: auth.membership.orgId, actorId: auth.user.id, txHash });
      if (state === "verified") revalidateOrgPages();
      return { ok: true, message: "", state };
    } catch (error) {
      return recordFailed("recordApprovalAction", error);
    }
  });
}

/** The gas for the owner's wallet to send the agent (W10). */
export async function prepareAgentGasAction(orgSlug: string): Promise<PreparedActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, transaction: null };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", transaction: await prepareAgentGas({ orgId: auth.membership.orgId }) };
    } catch (error) {
      return { ...failed("prepareAgentGasAction", error), transaction: null };
    }
  });
}
