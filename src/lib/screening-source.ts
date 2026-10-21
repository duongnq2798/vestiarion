import { currentConfig } from "./context";
import { PROVIDER_NAMES } from "./screening/providers";

/**
 * The screening source the console names: the provider (screening providers SP4), the bundled list, or no service at
 * all for a live workspace on a deployment without one, whose counterparties stay unscreened (payment safety K1). Call
 * it inside a workspace's scope: the workspace's configuration screens a sandbox against the bundled list and leaves a
 * live workspace with no service unscreened, where the deployment's alone would not (src/lib/shell-status.ts, workspace
 * shell design S5).
 */
export function screeningSourceLabel(): string {
  const { openSanctionsUrl, screeningProvider, serviceRequired } = currentConfig().compliance;
  if (openSanctionsUrl) return PROVIDER_NAMES[screeningProvider ?? "opensanctions"].label;
  return serviceRequired ? "no service" : "bundled list";
}
