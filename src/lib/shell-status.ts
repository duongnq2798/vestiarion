import { screeningMode } from "./compliance";
import { db } from "./dal";
import { readEarnedVendorRule } from "./earned-vendors-store";
import { readNewestLiveCheck } from "./screening/health";
import { screeningSourceLabel } from "./screening-source";
import { readShadowMode } from "./shadow-mode";

/**
 * What a workspace page's header says beside the chain modes (workspace shell design S5): whether shadow mode is on,
 * and the workspace's own screening. Call it inside the page's organization scope (`inOrg`), as every page does in
 * `<ProductShell … status={await shellStatus()}>`: out of scope, the screening settings would be the deployment's,
 * not the workspace's (a sandbox screens against the bundled list even where the deployment has OpenSanctions).
 *
 * Best effort: a shadow mode that cannot be read is `null`, which the header says as "Could not be read" rather than
 * off. Nothing here decides a payment; the agent reads shadow mode itself, and refuses to pay on a guess.
 *
 * A live workspace's newest live check is read beside shadow mode, at the same time (screening health SH4): one
 * indexed `limit 1` query, and none at all for a workspace that does not screen live. When it failed, the header stops
 * saying plain "Live". A newest check that cannot be read leaves "Live" as it was: it is the configured fact, and
 * nothing is paid on it.
 *
 * In shadow mode, the owner's switch that lets the agent pay earned vendors on their own is read after it
 * (docs/superpowers/specs/2026-10-28-earned-vendors-design.md AL28), so the header says the exception; best effort, a
 * switch that cannot be read is left out, and the agent reads it itself before paying anyone this way.
 */
export interface ShellStatus {
  shadow: boolean | null;
  /** In shadow mode, the agent pays earned vendors on its own; present only when it does. */
  earnedPayments?: true;
  screening: { live: boolean; source: string; lastLookupFailed: boolean };
}

async function shadowOn(): Promise<boolean | null> {
  try {
    return (await readShadowMode(db())) !== null;
  } catch (error) {
    console.error("shell status: shadow mode not read", error instanceof Error ? error.message : error);
    return null;
  }
}

async function earnedPaymentsOn(): Promise<boolean> {
  try {
    return (await readEarnedVendorRule(db())).payments;
  } catch (error) {
    console.error("shell status: earned vendors not read", error instanceof Error ? error.message : error);
    return false;
  }
}

async function lastLookupFailed(): Promise<boolean> {
  try {
    return (await readNewestLiveCheck(db()))?.status === "failed";
  } catch (error) {
    console.error("shell status: newest live check not read", error instanceof Error ? error.message : error);
    return false;
  }
}

export async function shellStatus(): Promise<ShellStatus> {
  const live = screeningMode() === "live";
  const [shadow, failed] = await Promise.all([shadowOn(), live ? lastLookupFailed() : Promise.resolve(false)]);
  const earned = shadow === true && (await earnedPaymentsOn());
  return { shadow, ...(earned ? { earnedPayments: true as const } : {}), screening: { live, source: screeningSourceLabel(), lastLookupFailed: failed } };
}
