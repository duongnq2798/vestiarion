import { capabilityOf, paysSimulated, type Capability, type CapabilityFacts } from "./capability";
import { chainModes, paymentsHoldReason } from "./circle";
import { db } from "./dal";
import { paymentsSwitchForPages } from "./payments-switch";
import { readShadowMode } from "./shadow-mode";
import { workspaceNetwork } from "./workspace-network";

/**
 * The facts `capabilityOf` adds up, read inside a workspace's scope (docs/superpowers/specs/2026-10-14-capability-and-
 * reasons-design.md R2): the platform's payments switch, the workspace's hold and chain mode, and shadow mode. The same
 * facts the header reads, and the payment gates refuse on: the switch as every page reads it, the hold as `shellModes()`
 * says it. Best effort: a shadow mode that cannot be read is null, which says "not known" and never live.
 */
export async function readCapabilityFacts(known: { shadow?: boolean | null } = {}): Promise<CapabilityFacts> {
  const network = workspaceNetwork().id;
  const hold = paymentsHoldReason();
  const { mode } = chainModes();
  const [payments, shadow] = await Promise.all([paymentsSwitchForPages(), known.shadow !== undefined ? Promise.resolve(known.shadow) : readShadowSafely()]);
  return {
    network,
    payments: payments.off ? { state: "off", reason: payments.reason ?? null } : payments.unread ? { state: "unread" } : { state: "on" },
    hold,
    chainMode: mode,
    shadow,
  };
}

/** The workspace's capability, in scope. `known.shadow` saves a second read when the page has it already. */
export async function readCapability(known: { shadow?: boolean | null } = {}): Promise<Capability> {
  return capabilityOf(await readCapabilityFacts(known));
}

/**
 * Whether the workspace in scope simulates its payments: the capability of its chain alone, with no hold, the switch on
 * and shadow mode aside (a payment agreed to in shadow mode is simulated too). For the pages that say only that, and
 * read nothing for it: the shared report, the payee's page and email. Never throws: false when it cannot be told.
 */
export function simulatesPayments(): boolean {
  try {
    return paysSimulated(capabilityOf({ network: workspaceNetwork().id, payments: { state: "on" }, hold: paymentsHoldReason(), chainMode: chainModes().mode, shadow: false }));
  } catch (error) {
    console.error("capability: chain mode not read", error instanceof Error ? error.message : error);
    return false;
  }
}

/** The same, for a sentence that can do without it: null, logged, when any fact could not be read. Never throws. */
export async function readCapabilitySafely(known: { shadow?: boolean | null } = {}): Promise<Capability | null> {
  try {
    return await readCapability(known);
  } catch (error) {
    console.error("capability not read", error instanceof Error ? error.message : error);
    return null;
  }
}

async function readShadowSafely(): Promise<boolean | null> {
  try {
    return (await readShadowMode(db())) !== null;
  } catch (error) {
    console.error("capability: shadow mode not read", error instanceof Error ? error.message : error);
    return null;
  }
}
