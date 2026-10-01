import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BalanceTile, liveBalanceTileKey } from "@/components/vx/Treasury";
import { checkedLabel, LiveBalanceView, nextTileState } from "@/components/vx/LiveBalance";
import type { Account } from "@/components/vx/types";

/**
 * The console's balance tile. In live mode it shows the stored balance at
 * once and reads the chain in the background (the read itself is
 * `refreshBalanceAction`, which the page hands down; a stand-in here, and
 * nothing is called by a static render); in sandbox mode it is the plain tile
 * it always was.
 */

const refreshMock = vi.fn();

const html = (node: ReactElement) => renderToStaticMarkup(node);

const ACCOUNTS: Account[] = [
  { id: "a1", name: "Operating", kind: "operating", chain: "ARC-TESTNET", token: "USDC", balance: 120, apy: 0, simulated: false },
  { id: "a2", name: "USYC reserve", kind: "reserve", chain: "ARC-TESTNET", token: "USYC", balance: 30, apy: 0.045, simulated: true },
];

const REFRESH_BUTTON = /<button[^>]*aria-label="Refresh the on-chain balance"[^>]*>/;

describe("BalanceTile, live", () => {
  const markup = html(<BalanceTile accounts={ACCOUNTS} mode="live" orgSlug="acme" refreshAction={refreshMock} syncedAt="2026-09-30T12:03:00.000Z" />);

  it("shows the stored balance at once", () => {
    expect(markup).toContain("Balance on-chain");
    expect(markup).toContain("120.00");
  });

  it("shows a ghost Refresh icon button with a label", () => {
    expect(markup).toMatch(REFRESH_BUTTON);
  });

  it("says when the balance was last checked", () => {
    expect(markup).toContain("Checked");
    expect(markup).toContain("12:03 UTC");
  });

  it("keeps the simulated reserve note", () => {
    expect(markup).toContain("in the simulated reserve, not counted above");
  });

  it("calls nothing while rendering", () => {
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("says it has not been checked when no read has happened yet", () => {
    expect(html(<BalanceTile accounts={ACCOUNTS} mode="live" orgSlug="acme" refreshAction={refreshMock} syncedAt={null} />)).toContain("Not checked yet");
  });
});

describe("BalanceTile, sandbox", () => {
  it("has no Refresh button and no Checked line", () => {
    const markup = html(<BalanceTile accounts={ACCOUNTS} mode="sandbox" orgSlug="acme" refreshAction={refreshMock} syncedAt="2026-09-30T12:03:00.000Z" />);
    expect(markup).toContain("Balance (simulated)");
    expect(markup).not.toMatch(/<button/);
    expect(markup).not.toContain("Checked");
  });

  it("stays the plain tile when no workspace is named (the design page)", () => {
    const markup = html(<BalanceTile accounts={ACCOUNTS} mode="live" />);
    expect(markup).toContain("Balance on-chain");
    expect(markup).not.toMatch(/<button/);
  });
});

describe("LiveBalanceView", () => {
  const base = { balance: 120, syncedAt: "2026-09-30T12:00:00.000Z", now: Date.parse("2026-09-30T12:03:30.000Z"), onRefresh: () => {} };

  it("says how long ago the balance was checked", () => {
    expect(html(<LiveBalanceView {...base} pending={false} failure={null} />)).toContain("Checked 3 min ago");
  });

  it("shows the operating wallet's EURC beside its USDC when it holds some", () => {
    const markup = html(<LiveBalanceView {...base} eurc={16.6} pending={false} failure={null} />);
    expect(markup).toContain("16.60");
    expect(markup).toContain("EURC");
    expect(markup).toContain("in the operating wallet");
  });

  it("shows no EURC line when it holds none, or none was read", () => {
    expect(html(<LiveBalanceView {...base} eurc={0} pending={false} failure={null} />)).not.toContain("EURC");
    expect(html(<LiveBalanceView {...base} eurc={null} pending={false} failure={null} />)).not.toContain("EURC");
  });

  it("disables the Refresh button and shows the spinner while a read is pending", () => {
    const markup = html(<LiveBalanceView {...base} pending failure={null} />);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Refresh the on-chain balance"|<button[^>]*aria-label="Refresh the on-chain balance"[^>]*disabled=""/);
    expect(markup).toContain("animate-spin");
  });

  it("says quietly when Circle could not be reached, next to how old the figure is — not instead of it", () => {
    const markup = html(<LiveBalanceView {...base} pending={false} failure="Could not reach Circle; showing the last known balance" />);
    expect(markup).toContain("120.00");
    expect(markup).toContain("Checked 3 min ago");
    expect(markup).toContain("Could not reach Circle; showing the last known balance");
    expect(markup).not.toContain("text-refused");
  });

  it("announces only the refresh's result: the ticking age stays outside the live region", () => {
    const liveRegions = (markup: string) => [...markup.matchAll(/<span[^>]*aria-live="polite"[^>]*>(.*?)<\/span>/g)].map((match) => match[1]);

    const quiet = html(<LiveBalanceView {...base} pending={false} failure={null} />);
    expect(liveRegions(quiet)).toEqual([""]);

    const failed = html(<LiveBalanceView {...base} pending={false} failure="Could not reach Circle; showing the last known balance" />);
    expect(liveRegions(failed)).toHaveLength(1);
    expect(liveRegions(failed)[0]).toContain("Could not reach Circle; showing the last known balance");
    expect(liveRegions(failed)[0]).not.toContain("Checked");
  });

  it("says it is checking when no read has finished yet", () => {
    expect(html(<LiveBalanceView {...base} syncedAt={null} pending failure={null} />)).toContain("Checking Circle");
  });
});

describe("nextTileState", () => {
  const previous = { balance: 100, syncedAt: "2026-09-30T11:00:00.000Z", failure: null };
  const FAILED = "Could not reach Circle; showing the last known balance";

  it("takes the new figures from a successful read and clears a failure", () => {
    expect(nextTileState({ ...previous, failure: FAILED }, { ok: true, balance: 120, syncedAt: "2026-09-30T12:00:00.000Z" })).toEqual({
      balance: 120, syncedAt: "2026-09-30T12:00:00.000Z", failure: null,
    });
  });

  it("takes the EURC a read brought, and keeps the last one when a read brought none", () => {
    const withEurc = nextTileState(previous, { ok: true, balance: 120, syncedAt: "2026-09-30T12:00:00.000Z", eurc: 16.6 });
    expect(withEurc.eurc).toBe(16.6);
    expect(nextTileState(withEurc, { ok: true, balance: 121, syncedAt: "2026-09-30T12:01:00.000Z" }).eurc).toBe(16.6);
    expect(nextTileState(withEurc, { ok: false, balance: null, syncedAt: null, message: FAILED }).eurc).toBe(16.6);
  });

  it("uses the partial figures a failed read still brought back, with the failure beside them", () => {
    expect(nextTileState(previous, { ok: false, balance: 110, syncedAt: "2026-09-30T12:00:00.000Z", message: FAILED })).toEqual({
      balance: 110, syncedAt: "2026-09-30T12:00:00.000Z", failure: FAILED,
    });
  });

  it("keeps the figures it had when a failed read brought none back", () => {
    expect(nextTileState(previous, { ok: false, balance: null, syncedAt: null, message: FAILED })).toEqual({ ...previous, failure: FAILED });
    expect(nextTileState(previous, { ok: false, balance: 100, syncedAt: null })).toEqual({ ...previous, failure: FAILED });
  });
});

describe("liveBalanceTileKey — new server figures remount the live tile", () => {
  it("changes when the page renders a new balance or a newer read", () => {
    const key = liveBalanceTileKey("2026-09-30T12:00:00.000Z", 120);
    expect(key).toBe("2026-09-30T12:00:00.000Z|120");
    expect(liveBalanceTileKey("2026-09-30T12:00:00.000Z", 80)).not.toBe(key);
    expect(liveBalanceTileKey("2026-09-30T12:05:00.000Z", 120)).not.toBe(key);
    expect(liveBalanceTileKey(null, 120)).toBe("|120");
  });

  it("is the key BalanceTile gives LiveBalanceTile, so a revalidated page does not keep the old state", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "components", "vx", "Treasury.tsx"), "utf8");
    expect(source).toMatch(/<LiveBalanceTile\s+key=\{liveBalanceTileKey\(syncedAt, initialBalance\)\}/);
  });
});

describe("checkedLabel", () => {
  const at = "2026-09-30T12:00:00.000Z";
  const plus = (ms: number) => Date.parse(at) + ms;

  it("reads just now within the minute, and for a clock slightly behind", () => {
    expect(checkedLabel(at, plus(0))).toBe("Checked just now");
    expect(checkedLabel(at, plus(59_000))).toBe("Checked just now");
    expect(checkedLabel(at, plus(-5_000))).toBe("Checked just now");
  });

  it("reads minutes, then hours, then days", () => {
    expect(checkedLabel(at, plus(3 * 60_000))).toBe("Checked 3 min ago");
    expect(checkedLabel(at, plus(59 * 60_000))).toBe("Checked 59 min ago");
    expect(checkedLabel(at, plus(60 * 60_000))).toBe("Checked 1 hour ago");
    expect(checkedLabel(at, plus(5 * 60 * 60_000))).toBe("Checked 5 hours ago");
    expect(checkedLabel(at, plus(24 * 60 * 60_000))).toBe("Checked 1 day ago");
    expect(checkedLabel(at, plus(3 * 24 * 60 * 60_000))).toBe("Checked 3 days ago");
  });

  it("falls back to the time of the read when there is no clock yet (the server render)", () => {
    expect(checkedLabel(at, null)).toBe("Checked Sep 30, 2026, 12:00 UTC");
  });
});

describe("the console page", () => {
  const source = (...parts: string[]) => readFileSync(path.join(process.cwd(), ...parts), "utf8");

  it("hands the tile the action, the workspace, and the operating account's last read", () => {
    const page = source("src", "app", "o", "[slug]", "console", "page.tsx");
    expect(page).toContain("refreshAction={refreshOnChainBalanceAction}");
    expect(page).toContain("orgSlug={slug}");
    expect(page).toMatch(/syncedAt=\{accountsRows\.find\(\(account\) => account\.kind === "operating" && account\.circle_wallet_id\)\?\.balance_synced_at \?\? null\}/);
  });

  it("keeps the action module out of the tile's imports, but for its type", () => {
    for (const file of ["LiveBalance.tsx", "Treasury.tsx"]) {
      const imports = source("src", "components", "vx", file).match(/^import .*"@\/app\/actions\/treasury";$/gm) ?? [];
      expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
    }
  });
});
