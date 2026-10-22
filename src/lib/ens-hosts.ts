/**
 * Where ENS names and Basenames are looked up (docs/superpowers/specs/2026-10-22-ens-address-names-design.md EN4): pure
 * data, read by ./ens on the server and by the privacy page's list of RPC nodes.
 */

/** Ethereum's node names are looked up on, unless ENS_RPC_URL names another: PublicNode's. */
export const ENS_RPC_DEFAULT = "https://ethereum-rpc.publicnode.com";

/** The gateways a name's resolver may send the server to: Coinbase's, for Basenames. Any other is never fetched. */
export const ENS_GATEWAY_HOSTS: readonly string[] = ["api.coinbase.com"];
