import { describe, expect, it } from "vitest";
import { statusChips, statusRows, statusSummary, type PageStatus, type PlatformStatus } from "@/components/vx/workspace-status";
import { MAINNET_NOT_LIVE, MAINNET_OFF } from "@/lib/mainnet";

/**
 * The workspace header's status (docs/superpowers/specs/2026-10-10-workspace-shell-design.md S5): three chips that
 * each answer one question in words, and the panel's rows. The network, what happens to payments and what the agent
 * is doing are kept apart, and each comes from the source that decides it.
 */

const platform = (over: Partial<PlatformStatus> = {}): PlatformStatus => ({
  network: "arc-testnet",
  mode: "live",
  mainnetEnabled: true,
  paymentsOff: null,
  pause: null,
  ...over,
});
const page = (over: Partial<PageStatus> = {}): PageStatus => ({
  chain: { mode: "live", earnMode: "simulate", held: false },
  shadow: false,
  screening: { live: true, source: "OpenSanctions" },
  clock: { mode: "real", day: 3 },
  ...over,
});
const labels = (platformStatus: PlatformStatus, pageStatus?: PageStatus) => statusChips(platformStatus, pageStatus).map((chip) => chip.label);
const row = (key: string, platformStatus: PlatformStatus, pageStatus?: PageStatus) => statusRows(platformStatus, pageStatus).find((candidate) => candidate.key === key);

describe("the header's chips", () => {
  it("say the network, what happens to payments and what the agent does, in that order", () => {
    expect(statusChips(platform(), page())).toEqual([
      { key: "network", label: "Arc testnet", tone: "quiet" },
      { key: "payments", label: "Payments live", tone: "good" },
      { key: "agent", label: "Agent on", tone: "good" },
    ]);
  });

  it("set Arc mainnet apart: real money, in the brand colour", () => {
    expect(statusChips(platform({ network: "arc-mainnet" }), page())[0]).toEqual({ key: "network", label: "Arc mainnet", tone: "mainnet" });
    expect(row("payments", platform({ network: "arc-mainnet" }), page())?.detail).toBe("Approved payments move real USDC on Arc mainnet.");
    expect(row("payments", platform(), page())?.detail).toBe("Approved payments are sent in USDC on Arc testnet.");
  });

  it("follow the provider, not the workspace's mode: a sandbox with a wallet pays on chain, one without simulates", () => {
    expect(labels(platform({ mode: "sandbox" }), page())[1]).toBe("Payments live");
    expect(labels(platform(), page({ chain: { mode: "simulate", earnMode: "simulate", held: false } }))[1]).toBe("Payments simulated");
  });

  it("say shadow mode when a person's verdict releases each payment", () => {
    expect(statusChips(platform(), page({ shadow: true }))[1]).toEqual({ key: "payments", label: "Shadow mode", tone: "shadow" });
    expect(row("payments", platform(), page({ shadow: true }))?.value).toBe("Live, after your verdict");
    expect(row("payments", platform(), page({ shadow: true, chain: { mode: "simulate", earnMode: "simulate", held: false } }))?.value).toBe("Simulated, after your verdict");
  });

  it("never guess shadow mode when it could not be read: the agent pays nothing on it, and the header says it is not known", () => {
    expect(statusChips(platform(), page({ shadow: null }))[1]).toEqual({ key: "payments", label: "Payments", tone: "unknown" });
    expect(row("payments", platform(), page({ shadow: null }))?.detail).toBe("Whether shadow mode is on could not be read, and the agent pays nothing until it can.");
    expect(row("shadow", platform(), page({ shadow: null }))).toMatchObject({ value: "Could not be read", tone: "unknown" });
  });

  it("never say payments live or the agent on from a switch or a pause it could not read", () => {
    const unread = platform({ paymentsUnread: true, pauseUnread: true });
    expect(statusChips(unread, page())).toEqual([
      { key: "network", label: "Arc testnet", tone: "quiet" },
      { key: "payments", label: "Payments", tone: "unknown" },
      { key: "agent", label: "Agent", tone: "unknown" },
    ]);
    expect(row("payments", unread, page())?.detail).toBe("Whether payments are switched on could not be read, and every payment is refused until it can be.");
    expect(row("agent", unread, page())?.value).toBe("Could not be read");
  });

  it("say the agent is stopped, not on, while nothing can be paid: every cycle refuses first", () => {
    const notLive = platform({ network: "arc-mainnet", mode: "sandbox" });
    expect(labels(notLive)[2]).toBe("Agent stopped");
    expect(labels(platform(), page({ chain: { mode: "live", earnMode: "simulate", held: true } }))[2]).toBe("Agent stopped");
    // Paused as well: held wins, and the panel does not offer Approvals, which the same hold refuses.
    const pausedAndHeld = platform({ network: "arc-mainnet", mode: "sandbox", pause: { since: "2026-09-29T14:05:12Z", by: "ada@example.com", reason: null } });
    expect(row("agent", pausedAndHeld)?.detail).toBe("Nothing can be paid from this workspace right now, so the agent does not run.");
  });

  it("say held when nothing can pay, ahead of shadow mode and the chain's mode (final review I2)", () => {
    for (const mode of ["live", "simulate"] as const) {
      expect(labels(platform(), page({ shadow: true, chain: { mode, earnMode: "simulate", held: true } }))[1]).toBe("Payments held");
    }
  });

  it("say why Arc mainnet holds payments, with the words every gate reads, before the page has loaded", () => {
    const notLive = platform({ network: "arc-mainnet", mode: "sandbox" });
    expect(labels(notLive)[1]).toBe("Payments held");
    expect(row("payments", notLive)?.detail).toBe(MAINNET_NOT_LIVE);
    const off = platform({ network: "arc-mainnet", mainnetEnabled: false });
    expect(row("payments", off, page())?.detail).toBe(MAINNET_OFF);
  });

  it("say payments off and the agent stopped while the platform's switch is off, with its reason", () => {
    const off = platform({ paymentsOff: { reason: "Provider incident" } });
    expect(statusChips(off, page({ shadow: true }))).toEqual([
      { key: "network", label: "Arc testnet", tone: "quiet" },
      { key: "payments", label: "Payments off", tone: "stopped" },
      { key: "agent", label: "Agent stopped", tone: "held" },
    ]);
    expect(row("payments", off, page())?.detail).toContain("Provider incident");
  });

  it("say the agent is paused, by whom and why, and that people can still pay", () => {
    const paused = platform({ pause: { since: "2026-09-29T14:05:12Z", by: "ada@example.com", reason: "Suspicious vendor" } });
    expect(labels(paused, page())[2]).toBe("Agent paused");
    expect(row("agent", paused, page())?.detail).toBe("Paused since Sep 29, 2026, 14:05 UTC by ada@example.com: Suspicious vendor. People can still pay from Approvals.");
  });

  it("say only what the layout knows while the page loads, and that the rest is not known here", () => {
    expect(statusChips(platform())[1]).toEqual({ key: "payments", label: "Payments", tone: "unknown" });
    expect(row("payments", platform())).toMatchObject({ value: "Not known yet", detail: "Not known on this screen: open or reload a section to see it." });
    expect(statusRows(platform()).map((candidate) => candidate.key)).toEqual(["network", "payments", "agent"]);
  });

  it("are one sentence for the button that opens the panel", () => {
    expect(statusSummary(statusChips(platform(), page({ shadow: true })))).toBe("Workspace status: Arc testnet, Shadow mode, Agent on");
  });

  it("never use the bare word Live as a label", () => {
    for (const chip of statusChips(platform({ network: "arc-mainnet" }), page())) expect(chip.label).not.toMatch(/^live$/i);
  });
});

describe("the status panel's rows", () => {
  it("say the network alone in its row, leaving payments to theirs", () => {
    expect(row("network", platform(), page())?.detail).toBe("Arc's public test network, with test USDC.");
    expect(row("network", platform({ network: "arc-mainnet", mode: "sandbox" }), page())?.detail).toBe("Arc's main network, where USDC is real money.");
  });

  it("list every fact on Arc testnet: network, payments, shadow mode, agent, reserve, screening, clock", () => {
    expect(statusRows(platform(), page()).map((candidate) => candidate.key)).toEqual(["network", "payments", "shadow", "agent", "reserve", "screening", "clock"]);
  });

  it("leave out shadow mode and the reserve on Arc mainnet, which has neither", () => {
    expect(statusRows(platform({ network: "arc-mainnet" }), page()).map((candidate) => candidate.key)).toEqual(["network", "payments", "agent", "screening", "clock"]);
  });

  it("say the workspace's own screening: the service, the bundled list, or none", () => {
    expect(row("screening", platform(), page())).toMatchObject({ value: "Live", tone: "good" });
    expect(row("screening", platform(), page({ screening: { live: false, source: "bundled list" } }))).toMatchObject({ value: "Bundled list", tone: "simulated" });
    expect(row("screening", platform(), page({ screening: { live: false, source: "no service" } }))).toMatchObject({ value: "No service", tone: "held" });
  });

  it("say the reserve is live only when the provider earns for real, and held with payments", () => {
    expect(row("reserve", platform(), page({ chain: { mode: "live", earnMode: "live", held: false } }))?.value).toBe("Live");
    expect(row("reserve", platform(), page())?.value).toBe("Simulated");
    expect(row("reserve", platform(), page({ chain: { mode: "live", earnMode: "live", held: true } }))?.value).toBe("Held");
  });

  it("say which clock the agent works on", () => {
    expect(row("clock", platform(), page())?.value).toBe("Wall clock");
    expect(row("clock", platform(), page({ clock: { mode: "simulate", day: 12 } }))?.value).toBe("Day 12");
  });
});
