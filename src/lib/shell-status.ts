import { screeningMode } from "./compliance";
import { db } from "./dal";
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
 */
export interface ShellStatus {
  shadow: boolean | null;
  screening: { live: boolean; source: string };
}

export async function shellStatus(): Promise<ShellStatus> {
  const screening = { live: screeningMode() === "live", source: screeningSourceLabel() };
  try {
    return { shadow: (await readShadowMode(db())) !== null, screening };
  } catch (error) {
    console.error("shell status: shadow mode not read", error instanceof Error ? error.message : error);
    return { shadow: null, screening };
  }
}
