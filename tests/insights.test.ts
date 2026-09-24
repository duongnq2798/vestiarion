import { describe, expect, it } from "vitest";
import { annotateScreeningChanges } from "@/lib/insights";

describe("screening insight provenance", () => {
  it("marks only completed tier transitions and ignores failed checks", () => {
    const rows = [
      {
        id: "1",
        counterparty_id: "cp-1",
        risk_level: "clear",
        screening_mode: "live" as const,
        source: "opensanctions:yente",
        status: "complete" as const,
        created_at: "2026-09-24T08:00:00.000Z",
        counterparties: { name: "Example Vendor" },
      },
      {
        id: "2",
        counterparty_id: "cp-1",
        risk_level: "clear",
        screening_mode: "live" as const,
        source: "opensanctions:yente",
        status: "failed" as const,
        created_at: "2026-09-24T09:00:00.000Z",
        counterparties: { name: "Example Vendor" },
      },
      {
        id: "3",
        counterparty_id: "cp-1",
        risk_level: "medium",
        screening_mode: "live" as const,
        source: "opensanctions:yente",
        status: "complete" as const,
        created_at: "2026-09-24T10:00:00.000Z",
        counterparties: { name: "Example Vendor" },
      },
    ];

    const result = annotateScreeningChanges(rows);
    expect(result.map((row) => ({ previous: row.previousRiskLevel, changed: row.tierChanged }))).toEqual([
      { previous: null, changed: false },
      { previous: "clear", changed: false },
      { previous: "clear", changed: true },
    ]);
  });
});
