import type { CycleClockMode } from "@/lib/clock";
import { utcMinute } from "@/lib/copy";
import { networkHold } from "@/lib/mainnet";
import { networkProfile, type Network } from "@/lib/network";

/**
 * What the workspace header says about a workspace (workspace shell design S5), as plain data: three chips, and the
 * rows of the "Workspace status" panel they open. Pure, so every combination is tested without a browser, and free of
 * server modules, so the header can be a client component.
 *
 * Two sources, kept apart. The layout knows the platform's facts (network, mode, the payments switch, the pause).
 * Only the page, inside the workspace's scope, knows the rest (whether payments are live, simulated or held, shadow
 * mode, screening, the clock); a loading or error state has none of them and says less rather than guess. A fact that
 * could not be read is said as such, never as its healthy value: the payment gates refuse on the same failure.
 */

/** What the workspace layout reads: platform data only, no organization rows. */
export interface PlatformStatus {
  network: Network;
  mode: "sandbox" | "live";
  /** The deployment's Arc mainnet switch, for the same hold every gate reads. */
  mainnetEnabled: boolean;
  /** The platform's payments switch, when it is off; the reason it records, if any. */
  paymentsOff: { reason: string | null } | null;
  /** The switch could not be read: every payment gate refuses until it can be. */
  paymentsUnread?: boolean;
  /** The agent's pause: since when, by whom (an email, or "a member") and why. */
  pause: { since: string; by: string; reason: string | null } | null;
  /** The pause could not be read. */
  pauseUnread?: boolean;
}

/** What the page reads inside the workspace's scope and hands to `ProductShell`. */
export interface PageStatus {
  /** `shellModes()`: the provider's modes, and whether nothing can pay now. */
  chain: { mode: "live" | "simulate"; earnMode: "live" | "simulate"; held: boolean };
  /** Whether shadow mode is on; null when it could not be read. */
  shadow: boolean | null;
  /** The workspace's own screening, read in its scope: live, and which source ("OpenSanctions", "bundled list", "no service"). */
  screening: { live: boolean; source: string };
  clock: { mode: CycleClockMode; day: number };
}

/**
 * How a chip or row is drawn. `quiet` is a fact that needs no attention; `good` a working state, shown by a jade dot
 * only; `mainnet` is real money; `shadow` is the agent waiting for people; `simulated` is drawn dashed; `held` and
 * `stopped` ask for attention; `unknown` is not known on this screen.
 */
export type StatusTone = "quiet" | "good" | "mainnet" | "shadow" | "simulated" | "held" | "stopped" | "unknown";

export interface StatusChip {
  key: "network" | "payments" | "agent";
  label: string;
  tone: StatusTone;
}

export interface StatusRow {
  key: "network" | "payments" | "shadow" | "agent" | "reserve" | "screening" | "clock";
  label: string;
  value: string;
  detail: string;
  tone: StatusTone;
}

type PaymentsState = "off" | "unread" | "held" | "shadow-unread" | "shadow" | "simulated" | "live" | "unknown";

const holdOf = (platform: PlatformStatus) => networkHold(platform.network, platform.mode, { mainnetEnabled: platform.mainnetEnabled });

function paymentsState(platform: PlatformStatus, page: PageStatus | undefined): PaymentsState {
  if (platform.paymentsOff) return "off";
  if (platform.paymentsUnread) return "unread";
  // The network hold needs nothing from the page: Arc mainnet switched off on this deployment, or not live yet.
  if (holdOf(platform)) return "held";
  if (!page) return "unknown";
  if (page.chain.held) return "held";
  // The agent pays nothing on a guess: a shadow mode it cannot read stops its payments too.
  if (page.shadow === null) return "shadow-unread";
  if (page.shadow) return "shadow";
  return page.chain.mode === "live" ? "live" : "simulated";
}

type AgentState = "stopped" | "held" | "unread" | "paused" | "on";

/** The agent runs no cycle while payments are off or held: every cycle refuses first (`assertPaymentsEnabled`). */
function agentState(platform: PlatformStatus, page: PageStatus | undefined): AgentState {
  if (platform.paymentsOff) return "stopped";
  if (holdOf(platform) || page?.chain.held) return "held";
  if (platform.pauseUnread) return "unread";
  return platform.pause ? "paused" : "on";
}

const PAYMENTS_CHIP: Record<PaymentsState, { label: string; tone: StatusTone }> = {
  off: { label: "Payments off", tone: "stopped" },
  unread: { label: "Payments", tone: "unknown" },
  held: { label: "Payments held", tone: "held" },
  "shadow-unread": { label: "Payments", tone: "unknown" },
  shadow: { label: "Shadow mode", tone: "shadow" },
  simulated: { label: "Payments simulated", tone: "simulated" },
  live: { label: "Payments live", tone: "good" },
  unknown: { label: "Payments", tone: "unknown" },
};

const AGENT_CHIP: Record<AgentState, { label: string; tone: StatusTone }> = {
  stopped: { label: "Agent stopped", tone: "held" },
  held: { label: "Agent stopped", tone: "held" },
  unread: { label: "Agent", tone: "unknown" },
  paused: { label: "Agent paused", tone: "held" },
  on: { label: "Agent on", tone: "good" },
};

/** The three chips, in reading order: where the money is, what happens to payments, what the agent is doing. */
export function statusChips(platform: PlatformStatus, page?: PageStatus): StatusChip[] {
  const network = networkProfile(platform.network);
  return [
    { key: "network", label: network.label, tone: platform.network === "arc-mainnet" ? "mainnet" : "quiet" },
    { key: "payments", ...PAYMENTS_CHIP[paymentsState(platform, page)] },
    { key: "agent", ...AGENT_CHIP[agentState(platform, page)] },
  ];
}

/** The chips as one sentence, for the button that opens the panel. */
export function statusSummary(chips: readonly StatusChip[]): string {
  return `Workspace status: ${chips.map((chip) => chip.label).join(", ")}`;
}

const NOT_KNOWN = "Not known on this screen: open or reload a section to see it.";

function paymentsRow(platform: PlatformStatus, page: PageStatus | undefined): StatusRow {
  const network = networkProfile(platform.network).label;
  const base = { key: "payments" as const, label: "Payments" };
  switch (paymentsState(platform, page)) {
    case "off":
      return {
        ...base,
        value: "Off",
        tone: "stopped",
        detail: `Payments are switched off for every workspace${platform.paymentsOff?.reason ? `: ${platform.paymentsOff.reason}` : ""}. Nothing is paid, moved or locked until they are back on.`,
      };
    case "unread":
      return { ...base, value: "Could not be read", tone: "unknown", detail: "Whether payments are switched on could not be read, and every payment is refused until it can be." };
    case "held":
      return { ...base, value: "Held", tone: "held", detail: holdOf(platform) ?? "Nothing can be paid from this workspace right now: its wallet cannot be reached." };
    case "shadow-unread":
      return { ...base, value: "Not known", tone: "unknown", detail: "Whether shadow mode is on could not be read, and the agent pays nothing until it can." };
    case "shadow":
      return {
        ...base,
        value: page?.chain.mode === "live" ? "Live, after your verdict" : "Simulated, after your verdict",
        tone: "shadow",
        detail:
          page?.chain.mode === "live"
            ? `Nothing is paid until a person agrees with the agent. A payment you agree to is sent in USDC on ${network}.`
            : "Nothing is paid until a person agrees with the agent. A payment you agree to is simulated: nothing is sent on chain.",
      };
    case "simulated":
      return { ...base, value: "Simulated", tone: "simulated", detail: "Payments are recorded here and nothing is sent on chain." };
    case "live":
      return {
        ...base,
        value: "Live",
        tone: platform.network === "arc-mainnet" ? "mainnet" : "good",
        detail: platform.network === "arc-mainnet" ? `Approved payments move real USDC on ${network}.` : `Approved payments are sent in USDC on ${network}.`,
      };
    case "unknown":
      return { ...base, value: "Not known yet", tone: "unknown", detail: NOT_KNOWN };
  }
}

function agentRow(platform: PlatformStatus, page: PageStatus | undefined): StatusRow {
  const base = { key: "agent" as const, label: "Agent" };
  switch (agentState(platform, page)) {
    case "stopped":
      return { ...base, value: "Stopped", tone: "held", detail: "Payments are switched off, so the agent does not run." };
    case "held":
      return { ...base, value: "Stopped", tone: "held", detail: "Nothing can be paid from this workspace right now, so the agent does not run." };
    case "unread":
      return { ...base, value: "Could not be read", tone: "unknown", detail: "Whether the agent is paused could not be read. Reload the page to try again." };
    case "paused": {
      const pause = platform.pause as NonNullable<PlatformStatus["pause"]>;
      const reason = pause.reason?.trim();
      return {
        ...base,
        value: "Paused",
        tone: "held",
        detail: `Paused since ${utcMinute(pause.since)} by ${pause.by}${reason ? `: ${reason.replace(/[.!?]+$/, "")}.` : "."} People can still pay from Approvals.`,
      };
    }
    case "on":
      return { ...base, value: "On", tone: "good", detail: "It decides each bill within a minute of it arriving, within its limits." };
  }
}

/** The panel's rows. Without the page's facts (loading, error) it lists only what the layout knows. */
export function statusRows(platform: PlatformStatus, page?: PageStatus): StatusRow[] {
  const profile = networkProfile(platform.network);
  const mainnet = platform.network === "arc-mainnet";
  const rows: StatusRow[] = [
    // The network alone: what happens to payments on it is the next row's to say.
    { key: "network", label: "Network", value: profile.label, tone: mainnet ? "mainnet" : "quiet", detail: mainnet ? "Arc's main network, where USDC is real money." : "Arc's public test network, with test USDC." },
    paymentsRow(platform, page),
  ];
  // Shadow mode exists on Arc testnet only (shadow-mode.ts refuses mainnet).
  if (!mainnet && page) {
    rows.push(
      page.shadow === null
        ? { key: "shadow", label: "Shadow mode", value: "Could not be read", tone: "unknown", detail: "Reload the page to try again." }
        : page.shadow
          ? { key: "shadow", label: "Shadow mode", value: "On", tone: "shadow", detail: "The agent decides each bill, and each decision waits for a person's verdict." }
          : { key: "shadow", label: "Shadow mode", value: "Off", tone: "quiet", detail: "The agent pays what passes its checks; anything else waits in Approvals." }
    );
  }
  rows.push(agentRow(platform, page));
  if (page && profile.usyc) {
    const held = page.chain.held;
    const live = !held && page.chain.earnMode === "live";
    rows.push({
      key: "reserve",
      label: "Reserve",
      value: held ? "Held" : live ? "Live" : "Simulated",
      tone: held ? "held" : live ? "good" : "simulated",
      detail: held ? "Nothing moves in or out of the USYC reserve right now." : live ? "The USYC reserve is held on chain." : "The USYC reserve is simulated: its balance is modelled and no USYC is held.",
    });
  }
  if (page) {
    const source = page.screening.source;
    rows.push(
      page.screening.live
        ? { key: "screening", label: "Screening", value: "Live", tone: "good", detail: `Each counterparty is screened against ${source} when it is added, and checked again from time to time.` }
        : source === "no service"
          ? { key: "screening", label: "Screening", value: "No service", tone: "held", detail: "No screening service is set up, so new counterparties stay unscreened." }
          : { key: "screening", label: "Screening", value: "Bundled list", tone: "simulated", detail: "Counterparties are screened against a bundled list, not a live service." }
    );
    rows.push(
      page.clock.mode === "simulate"
        ? { key: "clock", label: "Clock", value: `Day ${page.clock.day}`, tone: "quiet", detail: "A demo clock: each run moves it one day forward." }
        : { key: "clock", label: "Clock", value: "Wall clock", tone: "quiet", detail: "The agent works on today's date." }
    );
  }
  return rows;
}
