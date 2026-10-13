/**
 * What a person's payment did, for its confirmation to show in the order a person asks it: has the money gone, how much,
 * to whom, who decided it, on which network, and where to check it (payment confirmation).
 */
export interface PaymentReceipt {
  /**
   * Confirmed by Circle, or submitted and not confirmed yet: a payment is never called confirmed before Circle says so,
   * nor sent while it is only submitted (settlement lifecycle I17).
   */
  state: "confirmed" | "confirming";
  /** A submitted payment Circle never answered, so no Circle id was recorded: its outcome is unknown (L3). */
  outcomeUnknown?: true;
  amount: number;
  currency: string;
  payee: string;
  /** Where it went out, as a person reads it: "Arc testnet", or that the sandbox simulated it. */
  network: string;
  /** How the person decided it: approved paying what the agent stopped, or agreed with the agent's decision (shadow mode). */
  decidedBy: "approval" | "verdict";
  /** Its transaction on the explorer, once it has a hash. */
  txUrl: string | null;
  /** Cash brought back from the reserve to pay it, in words; null when none was. */
  fromReserve: string | null;
}

/** Where a sandbox's payments go, which the simulator makes rather than a network. */
export const SIMULATED_NETWORK = "Sandbox (simulated)";
