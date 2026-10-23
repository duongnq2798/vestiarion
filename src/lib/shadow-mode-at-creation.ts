import "server-only";
import { authorize } from "./auth/authorize";
import { inOrg } from "./dal/scope";
import { startShadowMode } from "./shadow-mode";

/**
 * Shadow mode for a workspace just created (shadow mode S1), as Settings turns it on: an owner's (`approval.policy`),
 * through `startShadowMode`, which refuses Arc mainnet and writes the signed entry. In USDC, with the person who
 * created it as the actor. Says whether it turned on: the workspace stays created either way. The onboarding form uses
 * it when shadow mode is ticked, and a client's accountant link always (accountant client links AC3).
 */
export async function startShadowModeAtCreation(slug: string): Promise<boolean> {
  try {
    const auth = await authorize(slug, "approval.policy");
    if (!auth.ok) {
      console.error("shadow mode at creation refused", auth.message);
      return false;
    }
    await inOrg(auth, () => startShadowMode({ actorId: auth.user.id, currency: "USDC" }));
    return true;
  } catch (error) {
    console.error("shadow mode at creation failed", error instanceof Error ? error.message : "unknown error");
    return false;
  }
}
