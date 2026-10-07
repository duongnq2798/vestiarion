"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import {
  choosePasskeyTreasury,
  chooseWalletTreasury,
  createAgentWallet,
  preparePasskeySetup,
  recordPasskeySetup,
  recordRecovery,
  skipRecovery,
  prepareAgentGas,
  prepareApproval,
  prepareDeployment,
  proofMessage,
  recordApproval,
  recordDeployment,
  recordWalletControl,
  WalletTreasuryError,
  type WalletControlKind,
  type PreparedPasskeySetup,
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
    } catch (error) {
      return failed("chooseWalletTreasuryAction", error);
    }
    return { ok: true, message: await withAgentWallet(actor(auth), "Your wallet is this workspace's treasury.") };
  });
}

/**
 * The agent's wallet, made with the choice on either route (passkey treasury K4): it needs nothing from the owner. When
 * Circle cannot make it, the choice stands and the page offers its own step to try again.
 */
async function withAgentWallet(person: ReturnType<typeof actor>, chosen: string): Promise<string> {
  try {
    await createAgentWallet(person);
    return chosen;
  } catch (error) {
    if (!(error instanceof WalletTreasuryError)) console.error("wallet-treasury: the agent's wallet with the choice failed");
    return `${chosen} The agent's wallet was not created yet; create it below.`;
  } finally {
    revalidateOrgPages();
  }
}

/** The owner's passkey wallet, by its address, becomes the workspace's treasury (passkey treasury K3). */
export async function choosePasskeyTreasuryAction(orgSlug: string, address: string): Promise<WalletTreasuryActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await choosePasskeyTreasury({ ...actor(auth), address });
    } catch (error) {
      return failed("choosePasskeyTreasuryAction", error);
    }
    return { ok: true, message: await withAgentWallet(actor(auth), "Your passkey wallet is this workspace's treasury.") };
  });
}

export interface PreparedPasskeySetupResult extends WalletTreasuryActionResult {
  setup: PreparedPasskeySetup | null;
}

/** A passkey wallet's setup, for the browser to check and its passkey to sign as one user operation (K6). */
export async function preparePasskeySetupAction(
  orgSlug: string,
  input: { dailyUsdc: number | null; weeklyUsdc: number | null; capUsdc: number | null }
): Promise<PreparedPasskeySetupResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, setup: null };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", setup: await preparePasskeySetup({ orgId: auth.membership.orgId, ...input }) };
    } catch (error) {
      return { ...failed("preparePasskeySetupAction", error), setup: null };
    }
  });
}

/** A passkey wallet's setup, recorded once the chain shows it (K7). */
export async function recordPasskeySetupAction(orgSlug: string, input: { txHash: string; contract: string }): Promise<RecordActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, state: null };
  return inOrg(auth, async () => {
    try {
      const state = await recordPasskeySetup({ orgId: auth.membership.orgId, actorId: auth.user.id, ...input });
      if (state === "verified") revalidateOrgPages();
      return { ok: true, message: "", state };
    } catch (error) {
      return recordFailed("recordPasskeySetupAction", error);
    }
  });
}

/** A passkey wallet's recovery address, recorded once its registration is mined (K8). The words stay in the browser. */
export async function recordRecoveryAction(orgSlug: string, input: { recoveryAddress: string; txHash: string }): Promise<RecordActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, state: null };
  return inOrg(auth, async () => {
    try {
      const state = await recordRecovery({ orgId: auth.membership.orgId, actorId: auth.user.id, ...input });
      if (state === "verified") revalidateOrgPages();
      return { ok: true, message: "", state };
    } catch (error) {
      return recordFailed("recordRecoveryAction", error);
    }
  });
}

/** The owner goes without a recovery phrase, knowing a lost passkey loses the wallet (K8). */
export async function skipRecoveryAction(orgSlug: string): Promise<WalletTreasuryActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await skipRecovery({ orgId: auth.membership.orgId, actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: "" };
    } catch (error) {
      return failed("skipRecoveryAction", error);
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

const CONTROL_KINDS: ReadonlySet<string> = new Set<WalletControlKind>(["figures", "stop", "resume"]);

/**
 * Records a control the treasury's own wallet sent from Go live (docs/superpowers/specs/2026-10-07-treasury-wallet-controls-
 * design.md C4, C5): owner or admin, from the chain only. A figure loosened or payments resumed starts a cycle, so what the
 * old state held is decided again.
 */
export async function recordWalletControlAction(orgSlug: string, input: { txHash: string; kind: WalletControlKind }): Promise<RecordActionResult> {
  const auth = await authorize(orgSlug, "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, state: null };
  return inOrg(auth, async () => {
    if (!CONTROL_KINDS.has(input.kind)) return { ok: false, message: GENERIC, state: null };
    try {
      const recorded = await recordWalletControl({ orgId: auth.membership.orgId, actorId: auth.user.id, txHash: input.txHash, kind: input.kind });
      if (recorded.state === "verified") {
        revalidateOrgPages();
        if (recorded.loosened) raiseCycleEvent(auth, "budget_raised");
        if (recorded.resumed) raiseCycleEvent(auth, "agent_resumed");
      }
      return { ok: true, message: "", state: recorded.state };
    } catch (error) {
      return recordFailed("recordWalletControlAction", error);
    }
  });
}
