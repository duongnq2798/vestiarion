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

/** The workspace's owner, in its scope, or the refusal as a result. */
async function asOwner<T extends WalletTreasuryActionResult>(
  orgSlug: string,
  refused: Omit<T, keyof WalletTreasuryActionResult>,
  run: (access: { orgId: string; actorId: string; actorEmail: string | null }) => Promise<T>
): Promise<T> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, ...refused } as T;
  return inOrg(auth, () => run({ orgId: auth.membership.orgId, actorId: auth.user.id, actorEmail: auth.user.email ?? null }));
}

/** The message the owner's wallet signs to prove it is theirs (W3). */
export async function proofMessageAction(orgSlug: string, address: string): Promise<WalletTreasuryActionResult & { text: string | null }> {
  return asOwner(orgSlug, { text: null }, async ({ orgId }) => {
    try {
      return { ok: true, message: "", text: await proofMessage({ orgId, address }) };
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
  return asOwner(orgSlug, {}, async ({ orgId, actorId, actorEmail }) => {
    try {
      await chooseWalletTreasury({ orgId, actorId, actorEmail, ...proof });
      revalidateOrgPages();
      return { ok: true, message: "Your wallet is this workspace's treasury. Create the agent's wallet next." };
    } catch (error) {
      return failed("chooseWalletTreasuryAction", error);
    }
  });
}

/** Vestiarion creates the agent's wallet, which pays through the contract and holds only gas (W5). */
export async function createAgentWalletAction(orgSlug: string): Promise<WalletTreasuryActionResult> {
  return asOwner(orgSlug, {}, async ({ orgId, actorId, actorEmail }) => {
    try {
      await createAgentWallet({ orgId, actorId, actorEmail });
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
}

/** The deployment for the owner's wallet to send (W6). */
export async function prepareDeploymentAction(orgSlug: string, figures: { dailyUsdc: number | null; weeklyUsdc: number | null }): Promise<PreparedActionResult> {
  return asOwner(orgSlug, { transaction: null }, async ({ orgId }) => {
    try {
      return { ok: true, message: "", transaction: await prepareDeployment({ orgId, ...figures }) };
    } catch (error) {
      return { ...failed("prepareDeploymentAction", error), transaction: null };
    }
  });
}

/** The deployment the owner's wallet sent, recorded once the chain shows it (W8). */
export async function recordDeploymentAction(orgSlug: string, txHash: string): Promise<RecordActionResult> {
  return asOwner(orgSlug, { state: null }, async ({ orgId, actorId }) => {
    try {
      const state = await recordDeployment({ orgId, actorId, txHash });
      if (state === "verified") revalidateOrgPages();
      return { ok: true, message: "", state };
    } catch (error) {
      return { ...failed("recordDeploymentAction", error), state: null };
    }
  });
}

/** The approval for the owner's wallet to send on USDC (W9). */
export async function prepareApprovalAction(orgSlug: string, input: { capUsdc: number | null }): Promise<PreparedActionResult> {
  return asOwner(orgSlug, { transaction: null }, async ({ orgId }) => {
    try {
      return { ok: true, message: "", transaction: await prepareApproval({ orgId, capUsdc: input.capUsdc }) };
    } catch (error) {
      return { ...failed("prepareApprovalAction", error), transaction: null };
    }
  });
}

/** The approval the owner's wallet sent, recorded once the chain shows it (W9). */
export async function recordApprovalAction(orgSlug: string, txHash: string): Promise<RecordActionResult> {
  return asOwner(orgSlug, { state: null }, async ({ orgId, actorId }) => {
    try {
      const state = await recordApproval({ orgId, actorId, txHash });
      if (state === "verified") revalidateOrgPages();
      return { ok: true, message: "", state };
    } catch (error) {
      return { ...failed("recordApprovalAction", error), state: null };
    }
  });
}

/** The gas for the owner's wallet to send the agent (W10). */
export async function prepareAgentGasAction(orgSlug: string): Promise<PreparedActionResult> {
  return asOwner(orgSlug, { transaction: null }, async ({ orgId }) => {
    try {
      return { ok: true, message: "", transaction: await prepareAgentGas({ orgId }) };
    } catch (error) {
      return { ...failed("prepareAgentGasAction", error), transaction: null };
    }
  });
}
