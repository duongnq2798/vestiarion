import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import {
  factChanges,
  followUpConfig,
  planFollowUp,
  type DecisionFacts,
  type FollowUpConfig,
  type FrozenInvoice,
} from "@/lib/agent/follow-up";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();

const config: FollowUpConfig = { staleAfterDays: 3, reEscalateAfterDays: 7 };

const facts: DecisionFacts = {
  poReference: null,
  goodsReceived: false,
  riskLevel: "clear",
  paymentLimit: 2,
};

function frozen(over: Partial<FrozenInvoice> = {}): FrozenInvoice {
  return {
    id: "inv-1",
    status: "awaiting_info",
    amount: 0.95,
    dueDate: daysAhead(5),
    decidedAt: daysAgo(1),
    escalatedAt: null,
    poReference: null,
    goodsReceived: false,
    riskLevel: "clear",
    paymentLimit: 2,
    ...over,
  };
}

describe("factChanges", () => {
  it("sees a purchase order arrive", () => {
    const changes = factChanges({ ...facts, poReference: "PO-1042" }, facts);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toContain("since been supplied");
  });

  it("sees goods confirmed, and sees receipt withdrawn", () => {
    expect(factChanges({ ...facts, goodsReceived: true }, facts)[0]).toContain("confirmed received");
    expect(
      factChanges(facts, { ...facts, goodsReceived: true })[0]
    ).toContain("withdrawn");
  });

  it("sees a risk tier move in either direction", () => {
    expect(factChanges({ ...facts, riskLevel: "high" }, facts)[0]).toContain("clear → high");
    expect(factChanges(facts, { ...facts, riskLevel: "high" })[0]).toContain("high → clear");
  });

  it("sees a payment limit move, including to and from none", () => {
    expect(factChanges({ ...facts, paymentLimit: 8 }, facts)[0]).toContain("2 USDC → 8 USDC");
    expect(factChanges({ ...facts, paymentLimit: null }, facts)[0]).toContain("2 USDC → none");
  });

  it("reports nothing when nothing moved", () => {
    expect(factChanges(facts, facts)).toEqual([]);
  });

  it("reports every change, not just the first", () => {
    const changes = factChanges(
      { poReference: "PO-9", goodsReceived: true, riskLevel: "medium", paymentLimit: 9 },
      facts
    );
    expect(changes).toHaveLength(4);
  });

  it("ignores facts the payment decision does not rest on", () => {
    // A changed memo is not grounds to reopen a payment question.
    expect(factChanges({ ...facts }, { ...facts })).toEqual([]);
  });
});

describe("planFollowUp — reopening on changed evidence", () => {
  it("reopens when the purchase order the agent asked for arrives", () => {
    const plan = planFollowUp(frozen({ poReference: "PO-1042" }), facts, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.reason).toContain("evidence this decision rested on has changed");
  });

  it("reopens a held invoice when screening raises the limit back", () => {
    const plan = planFollowUp(
      frozen({ status: "held", paymentLimit: 8 }),
      { ...facts, paymentLimit: 0.5 },
      NOW,
      config
    );
    expect(plan.action).toBe("reopen");
    expect(plan.changes[0]).toContain("0.5 USDC → 8 USDC");
  });

  it("reopens on changed evidence even when the invoice is fresh", () => {
    // Freshness is a reason not to nag a human, never a reason to ignore new
    // evidence.
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(0.01), goodsReceived: true }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("reopen");
  });

  it("reopens rather than assuming, when no decision facts were recorded", () => {
    const plan = planFollowUp(frozen(), null, NOW, config);
    expect(plan.action).toBe("reopen");
    expect(plan.reason).toContain("No recorded decision facts");
  });
});

describe("planFollowUp — escalating on silence", () => {
  it("escalates once the question has gone unanswered past the threshold", () => {
    const plan = planFollowUp(frozen({ decidedAt: daysAgo(4) }), facts, NOW, config);
    expect(plan.action).toBe("escalate");
    expect(plan.reason).toContain("gone unanswered");
  });

  it("escalates a past-due invoice immediately, however recently decided", () => {
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(0.1), dueDate: daysAgo(1) }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("escalate");
    expect(plan.pastDue).toBe(true);
    expect(plan.reason).toContain("due date");
  });

  it("does not escalate an invoice that is merely recent", () => {
    const plan = planFollowUp(frozen({ decidedAt: daysAgo(1) }), facts, NOW, config);
    expect(plan.action).toBe("wait");
  });

  it("escalates exactly on the threshold, not a day late", () => {
    expect(planFollowUp(frozen({ decidedAt: daysAgo(3) }), facts, NOW, config).action).toBe("escalate");
  });

  it("names the amount a human has to rule on", () => {
    const plan = planFollowUp(
      frozen({ amount: 6.2, status: "held", dueDate: daysAgo(1) }),
      facts,
      NOW,
      config
    );
    expect(plan.reason).toContain("6.2 USDC");
  });
});

describe("planFollowUp — not turning into an alert treadmill", () => {
  it("does not escalate the same unchanged invoice every cycle", () => {
    // Telling a human the same thing every cycle is how an alert stops being
    // read at all.
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(10), escalatedAt: daysAgo(1) }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("wait");
    expect(plan.reason).toContain("re-escalation window");
  });

  it("escalates again once the re-escalation window has passed", () => {
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(20), escalatedAt: daysAgo(8) }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("escalate");
  });

  it("reopens on new evidence even inside the quiet window", () => {
    // Suppressing a repeat alert must never suppress a real change.
    const plan = planFollowUp(
      frozen({ decidedAt: daysAgo(10), escalatedAt: daysAgo(1), goodsReceived: true }),
      facts,
      NOW,
      config
    );
    expect(plan.action).toBe("reopen");
  });

  it("never re-runs the model on identical facts inside the window", () => {
    for (const age of [4, 10, 30, 365]) {
      const plan = planFollowUp(
        frozen({ decidedAt: daysAgo(age), escalatedAt: daysAgo(0.5) }),
        facts,
        NOW,
        config
      );
      expect(plan.action, `age ${age}d`).toBe("wait");
    }
  });
});

describe("followUpConfig", () => {
  // Validation moved into configFromEnv, so these build a config rather than
  // mutating the environment a running scope has already read.
  const cadence = (over: Record<string, string> = {}) =>
    runWithConfig(
      configFromEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://p.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "k",
        ...over,
      }),
      () => followUpConfig()
    );

  it("has usable defaults", () => {
    expect(cadence()).toEqual({ staleAfterDays: 3, reEscalateAfterDays: 7 });
  });

  it("reads an explicit cadence", () => {
    expect(cadence({ FOLLOW_UP_STALE_DAYS: "1", FOLLOW_UP_RE_ESCALATE_DAYS: "2" }))
      .toEqual({ staleAfterDays: 1, reEscalateAfterDays: 2 });
  });

  it("falls back to the default on nonsense rather than never escalating", () => {
    // A bad value must not mean "stay silent forever", which is the direction
    // that loses money quietly.
    for (const bad of ["", "abc", "-1", "0"]) {
      expect(cadence({ FOLLOW_UP_STALE_DAYS: bad }).staleAfterDays).toBe(3);
    }
  });
});
