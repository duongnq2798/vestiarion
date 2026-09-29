import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InsightsCharts } from "@/components/vx/InsightsCharts";
import type { InsightsData } from "@/lib/insights";

const empty: InsightsData = { transfers: [], runs: [], snapshots: [], treasuryMoves: [], screenings: [] };

describe("InsightsCharts", () => {
  it("shows an empty state in every chart card before anything is measured", () => {
    const markup = renderToStaticMarkup(<InsightsCharts data={empty} />);
    expect(markup.match(/recorded yet/g)).toHaveLength(5);
    expect(markup.match(/Run an agent cycle to populate this\./g)).toHaveLength(5);
    expect(markup).not.toContain("<svg");
  });

  it("says where transfers came from in words, and keeps the receipts in a table", () => {
    const data: InsightsData = {
      ...empty,
      transfers: [
        { id: "t1", targetType: "invoice", targetId: "i1", txRef: "0xabc0000000000000", feeUsd: 0.0031, feeSource: "chain_reported", settledInMs: 812, chain: "ARC-TESTNET", providerMode: "live", executedAt: "2026-09-29T10:00:00Z", status: "complete" },
        { id: "t2", targetType: "invoice", targetId: "i2", txRef: "sim_000000000000", feeUsd: 0.0029, feeSource: "simulated_profile", settledInMs: null, chain: "ARC-TESTNET", providerMode: "simulate", executedAt: "2026-09-29T11:00:00Z", status: "complete" },
      ],
    };
    const markup = renderToStaticMarkup(<InsightsCharts data={data} />);
    expect(markup).toContain("Transfers · MIXED");
    expect(markup).toContain("Transfer receipt table");
    expect(markup).toMatch(/<details class="[^"]*disclosure/);
    expect(markup).toContain("<table");
    expect(markup).not.toContain("rounded-sm");
  });
});
