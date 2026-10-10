import { currentConfig } from "./context";

/**
 * The screening source the console names: the service, the bundled list, or no service at all for a live workspace on
 * a deployment without one, whose counterparties stay unscreened (payment safety K1). Call it inside a workspace's
 * scope: the workspace's configuration screens a sandbox against the bundled list and leaves a live workspace with no
 * service unscreened, where the deployment's alone would not (src/lib/shell-status.ts, workspace shell design S5).
 */
export function screeningSourceLabel(): "OpenSanctions" | "bundled list" | "no service" {
  const { openSanctionsUrl, serviceRequired } = currentConfig().compliance;
  if (openSanctionsUrl) return "OpenSanctions";
  return serviceRequired ? "no service" : "bundled list";
}
