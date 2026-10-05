import { currentConfig } from "./context";

/**
 * The screening source the console names: the service, the bundled list, or no service at all for a live workspace on
 * a deployment without one, whose counterparties stay unscreened (payment safety K1). It reads configuration only, so
 * the workspace header may call it (tests/access-gates.test.ts).
 */
export function screeningSourceLabel(): "OpenSanctions" | "bundled list" | "no service" {
  const { openSanctionsUrl, serviceRequired } = currentConfig().compliance;
  if (openSanctionsUrl) return "OpenSanctions";
  return serviceRequired ? "no service" : "bundled list";
}
