import { currentConfig } from "./context";
import type { Network } from "./network";

/**
 * The network of the organization in scope (network foundation N1): what `orgConfig` read from its row, Arc testnet
 * when nothing says otherwise. Server-side: it reads the running scope's configuration.
 */
export function currentNetwork(): Network {
  return currentConfig().network ?? "arc-testnet";
}
