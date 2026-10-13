import { describe, expect, it } from "vitest";
import {
  ageBucketOf,
  ageWords,
  applyFilter,
  countByAge,
  countByKind,
  routeTo,
  sortTriage,
  triageFilter,
  type TriageItem,
  type TriageKind,
} from "@/lib/accountant/triage";

/**
 * The accountant console's queue (docs/superpowers/specs/2026-10-13-accountant-console-design.md A3, A5, A6): who acts on
 * each item, how old it is, the order, and the filters read from the address. It counts items and adds no money.
 */

const NOW = new Date("2026-10-13T09:00:00.000Z");

const item = (kind: TriageKind, since: string, over: Partial<TriageItem> = {}): TriageItem => ({
  key: `${over.workspace?.slug ?? "harbor"}:${kind}:${since}`,
  kind,
  workspace: { slug: "harbor", name: "Harbor" },
  title: "A",
  detail: "",
  amount: null,
  since,
  href: "/o/harbor/approvals",
  canAct: false,
  who: "",
  ...over,
});

describe("routeTo", () => {
  it("lets an accountant act on bookings and receivables, and sends decisions and connectors to the roles that hold them", () => {
    expect(routeTo("accountant", "to_book")).toEqual({ canAct: true, who: "You can review and book it" });
    expect(routeTo("accountant", "customer_says_paid").canAct).toBe(true);
    expect(routeTo("accountant", "disputed").canAct).toBe(true);
    expect(routeTo("accountant", "receivable_overdue").canAct).toBe(true);
    expect(routeTo("accountant", "decision")).toEqual({ canAct: false, who: "Waiting on an owner, admin or approver of this workspace" });
    expect(routeTo("accountant", "past_decide_by").canAct).toBe(false);
    expect(routeTo("accountant", "connector")).toEqual({ canAct: false, who: "Waiting on an owner or admin of this workspace" });
    expect(routeTo("accountant", "limit", "agent_budget").canAct).toBe(false);
  });

  it("lets an approver decide, and a viewer act on nothing", () => {
    expect(routeTo("approver", "decision")).toEqual({ canAct: true, who: "You can decide it" });
    expect(routeTo("approver", "to_book").canAct).toBe(false);
    for (const kind of ["decision", "to_book", "customer_says_paid", "connector"] as const) expect(routeTo("viewer", kind).canAct, kind).toBe(false);
    expect(routeTo("owner", "limit", "sandbox_cycles")).toEqual({ canAct: true, who: "You can act on it" });
    expect(routeTo("admin", "limit", "sandbox_cycles").who).toBe("Waiting on an owner of this workspace");
  });
});

describe("ages", () => {
  it("buckets an item by whole days open, a day still to come as today", () => {
    expect(ageBucketOf("2026-10-13T01:00:00Z", NOW)).toBe("day");
    expect(ageBucketOf("2026-10-12T08:00:00Z", NOW)).toBe("days");
    expect(ageBucketOf("2026-10-10", NOW)).toBe("days");
    expect(ageBucketOf("2026-10-09", NOW)).toBe("week");
    expect(ageBucketOf("2026-10-01", NOW)).toBe("month");
    expect(ageBucketOf("2026-09-01", NOW)).toBe("older");
    expect(ageBucketOf("2026-10-20", NOW)).toBe("day");
    expect(ageWords("2026-10-12T08:00:00Z", NOW)).toBe("1 day");
    expect(ageWords("2026-10-13T08:00:00Z", NOW)).toBe("Under a day");
  });

  it("counts every bucket, empty ones too, for the KPI", () => {
    const counts = countByAge([item("decision", "2026-10-13T08:00:00Z"), item("to_book", "2026-10-11"), item("disputed", "2026-08-01")], NOW);
    expect(counts.map(({ key, count }) => [key, count])).toEqual([
      ["day", 1],
      ["days", 1],
      ["week", 0],
      ["month", 0],
      ["older", 1],
    ]);
  });
});

describe("sortTriage", () => {
  it("puts what the viewer can act on first, then by kind, then the oldest", () => {
    const sorted = sortTriage([
      item("receivable_overdue", "2026-09-01", { canAct: true, title: "overdue" }),
      item("decision", "2026-10-01", { title: "decision" }),
      item("to_book", "2026-10-12", { canAct: true, title: "book new" }),
      item("to_book", "2026-10-02", { canAct: true, title: "book old" }),
      item("past_decide_by", "2026-10-10", { title: "past" }),
    ]);
    expect(sorted.map((entry) => entry.title)).toEqual(["book old", "book new", "overdue", "past", "decision"]);
  });

  it("gives the same order whatever order the workspaces answered in", () => {
    const a = item("decision", "2026-10-01", { workspace: { slug: "a", name: "Alpha" } });
    const b = item("decision", "2026-10-01", { workspace: { slug: "b", name: "Beta" } });
    expect(sortTriage([b, a])).toEqual(sortTriage([a, b]));
  });
});

describe("filters", () => {
  const items = [
    item("decision", "2026-10-01", { workspace: { slug: "harbor", name: "Harbor" } }),
    item("to_book", "2026-10-01", { canAct: true, workspace: { slug: "lumen", name: "Lumen" } }),
  ];

  it("reads only a known kind, a slug and mine=1 from the address", () => {
    expect(triageFilter({ kind: "to_book", workspace: "lumen", mine: "1" })).toEqual({ kind: "to_book", workspace: "lumen", mine: true });
    expect(triageFilter({ kind: "drop_table", workspace: "../x", mine: "yes" })).toEqual({ kind: null, workspace: null, mine: false });
    expect(triageFilter({ kind: ["decision", "to_book"] }).kind).toBe("decision");
  });

  it("narrows the queue by kind, workspace and what the viewer can act on", () => {
    expect(applyFilter(items, triageFilter({ mine: "1" })).map((entry) => entry.kind)).toEqual(["to_book"]);
    expect(applyFilter(items, triageFilter({ workspace: "harbor" })).map((entry) => entry.kind)).toEqual(["decision"]);
    expect(applyFilter(items, triageFilter({ kind: "connector" }))).toEqual([]);
    expect(countByKind(items)).toEqual([
      { kind: "decision", count: 1 },
      { kind: "to_book", count: 1 },
    ]);
  });
});
