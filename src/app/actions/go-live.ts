"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { chooseHostedWallet, connectCircle, createWallets, goLive, GoLiveError, operatingBalance } from "@/lib/platform/go-live";

/**
 * The three Go live steps (docs/superpowers/specs/2026-09-29-go-live-design.md)
 * and the hosted-wallet choice (2026-09-30-hosted-wallets-design.md), owner
 * only (L1). The Circle credentials arrive in form data, go straight to
 * `connectCircle`, and are never returned, logged or revalidated into a page:
 * the result is only ever `{ ok, message }` with a fixed message.
 */

export interface GoLiveActionResult {
  ok: boolean;
  message: string;
}

/** The Go live step's balance line: the operating wallet's USDC on chain, or null when it could not be read. */
export interface BalanceActionResult extends GoLiveActionResult {
  balance: number | null;
}

const GENERIC = "Something went wrong; try again.";

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * A `GoLiveError` carries a message safe to show. Anything else is logged by
 * the action's name alone: its message may be Circle's, or quote the request.
 */
function fail(action: string, error: unknown): GoLiveActionResult {
  if (error instanceof GoLiveError) return { ok: false, message: error.message };
  console.error(`go-live: ${action} failed`);
  return { ok: false, message: GENERIC };
}

/** Form fields: `orgSlug`, `apiKey`, `entitySecret`. */
export async function connectCircleAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await connectCircle({
        orgId: auth.membership.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        apiKey: formString(formData, "apiKey"),
        entitySecret: formString(formData, "entitySecret"),
      });
      revalidateOrgPages();
      return { ok: true, message: "Circle is connected." };
    } catch (error) {
      return fail("connectCircleAction", error);
    }
  });
}

/**
 * Form fields: `orgSlug`. The connect step's other choice (hosted wallets H4):
 * the workspace's wallets will live in Vestiarion's hosted Circle testnet
 * account. It takes no credentials, and returns none.
 */
export async function chooseHostedWalletAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await chooseHostedWallet({ orgId: auth.membership.orgId, actorId: auth.user.id });
      revalidateOrgPages();
      return { ok: true, message: "This workspace will use a Vestiarion testnet wallet; create its treasury wallets next." };
    } catch (error) {
      return fail("chooseHostedWalletAction", error);
    }
  });
}

/** Form fields: `orgSlug`. */
export async function createWalletsAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const { created } = await createWallets({ orgId: auth.membership.orgId, actorId: auth.user.id, actorEmail: auth.user.email });
      return {
        ok: true,
        message: created > 0 ? `Treasury wallets created: ${created}.` : "Every account already has a wallet.",
      };
    } catch (error) {
      return fail("createWalletsAction", error);
    } finally {
      // Wallets written before a failure are kept (provisioning is idempotent), so the page shows them either way.
      revalidateOrgPages();
    }
  });
}

/** Form fields: `orgSlug`. */
export async function goLiveAction(_previous: GoLiveActionResult, formData: FormData): Promise<GoLiveActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      await goLive({
        orgId: auth.membership.orgId,
        actorId: auth.user.id,
        actorEmail: auth.user.email,
        confirmation: formString(formData, "confirmation"),
      });
      revalidateOrgPages();
      return { ok: true, message: "This workspace is live." };
    } catch (error) {
      return fail("goLiveAction", error);
    }
  });
}

/**
 * Form fields: `orgSlug`. Reads the operating wallet's USDC balance on chain
 * for the Go live step, and writes nothing, so it revalidates nothing. The
 * result carries the number only: no wallet id, and no error of Circle's.
 */
export async function refreshBalanceAction(_previous: BalanceActionResult, formData: FormData): Promise<BalanceActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message, balance: null };
  return inOrg(auth, async () => {
    try {
      return { ok: true, message: "", balance: await operatingBalance() };
    } catch (error) {
      if (error instanceof GoLiveError) return { ok: false, message: error.message, balance: null };
      console.error("go-live: refreshBalanceAction failed");
      return { ok: false, message: "Could not read the balance from Circle; try again.", balance: null };
    }
  });
}
