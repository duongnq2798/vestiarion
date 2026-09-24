import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyOpenSanctionsCandidate,
  isScreeningDue,
  paymentLimitForRisk,
  planScreening,
  rescreenIntervalMs,
  screenName,
  type CounterpartyScreeningRow,
} from "@/lib/compliance";

function row(over: Partial<CounterpartyScreeningRow> = {}): CounterpartyScreeningRow {
  return {
    id: "cp-1",
    name: "Vercel Inc",
    risk_level: "unscreened",
    payment_limit: 2000,
    baseline_payment_limit: null,
    last_screened_at: null,
    ...over,
  };
}

/** Feeds a plan's output back in as the next screen's input, N times over. */
function rescreen(start: CounterpartyScreeningRow, times: number) {
  let current = start;
  let last = planScreening(current);
  for (let i = 0; i < times; i++) {
    last = planScreening(current);
    current = {
      ...current,
      risk_level: last.result.riskLevel,
      payment_limit: last.newLimit,
      baseline_payment_limit: last.baseline,
      last_screened_at: new Date().toISOString(),
    };
  }
  return { plan: last, final: current };
}

describe("screenName", () => {
  it("flags a watchlisted shell entity as high risk", async () => {
    expect((await screenName("Zenith Trading LLC")).riskLevel).toBe("high");
  });

  it("matches regardless of case and surrounding text", async () => {
    expect((await screenName("ZENITH TRADING (HK) Limited")).riskLevel).toBe("high");
  });

  it("returns the medium tier for a thin-file counterparty", async () => {
    expect((await screenName("Wardrobe Holdings Ltd")).riskLevel).toBe("medium");
  });

  it("clears a counterparty with no match", async () => {
    const result = await screenName("Vercel Inc");
    expect(result.riskLevel).toBe("clear");
    expect(result.source).toBe("simulated-sanctions-list");
  });

  it("always names its source, so the ledger records where a verdict came from", async () => {
    for (const name of ["Vercel Inc", "Zenith Trading LLC", "Wardrobe Holdings Ltd"]) {
      expect((await screenName(name)).source).toBeTruthy();
    }
  });
});

describe("OpenSanctions tier mapping", () => {
  const candidate = (score: number, topics: string[]) => ({
    id: "NK-test",
    caption: "Matched Entity",
    score,
    target: true,
    properties: { topics },
  });

  it("maps a strong sanctions identity match to high", () => {
    expect(classifyOpenSanctionsCandidate(candidate(0.91, ["sanction"]))).toMatchObject({
      riskLevel: "high",
      rawScore: 0.91,
      matchedEntityId: "NK-test",
      screeningMode: "live",
    });
  });

  it("keeps a weaker sanctions match at medium for review", () => {
    expect(classifyOpenSanctionsCandidate(candidate(0.75, ["sanction.linked"])).riskLevel).toBe("medium");
  });

  it("maps a PEP or other non-sanctions hit to medium", () => {
    expect(classifyOpenSanctionsCandidate(candidate(0.96, ["role.pep"]))).toMatchObject({
      riskLevel: "medium",
      matchedTopics: ["role.pep"],
    });
  });

  it("maps no candidate to clear without inventing a score", () => {
    expect(classifyOpenSanctionsCandidate(undefined)).toMatchObject({
      riskLevel: "clear",
      rawScore: null,
      matchedEntityId: null,
    });
  });
});

describe("screenName with OpenSanctions", () => {
  const originalUrl = process.env.OPENSANCTIONS_API_URL;
  const originalKey = process.env.OPENSANCTIONS_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.OPENSANCTIONS_API_URL;
    else process.env.OPENSANCTIONS_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.OPENSANCTIONS_API_KEY;
    else process.env.OPENSANCTIONS_API_KEY = originalKey;
  });

  it("sends name and jurisdiction to the match endpoint and records raw evidence", async () => {
    process.env.OPENSANCTIONS_API_URL = "https://yente.internal/";
    process.env.OPENSANCTIONS_API_KEY = "secret-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      responses: {
        counterparty: {
          status: 200,
          results: [{
            id: "NK-live",
            caption: "Acme Match",
            score: 0.93,
            target: true,
            properties: { topics: ["sanction"], jurisdiction: ["gb"] },
          }],
        },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await screenName("Acme Limited", "gb");
    expect(result).toMatchObject({ riskLevel: "high", rawScore: 0.93, matchedEntityId: "NK-live" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://yente.internal/match/default");
    expect(init.headers).toMatchObject({ Authorization: "ApiKey secret-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      queries: { counterparty: { properties: { name: ["Acme Limited"], jurisdiction: ["gb"] } } },
    });
  });

  it("throws on an unavailable provider instead of returning clear", async () => {
    process.env.OPENSANCTIONS_API_URL = "https://yente.internal";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(screenName("Acme Limited")).rejects.toThrow("HTTP 503");
  });
});

describe("paymentLimitForRisk", () => {
  it("leaves a clear counterparty's limit alone", () => {
    expect(paymentLimitForRisk("clear", 2000)).toBe(2000);
  });

  it("tiers a medium-risk counterparty down to a quarter", () => {
    expect(paymentLimitForRisk("medium", 2000)).toBe(500);
  });

  it("cuts a high-risk counterparty to zero, not to null", () => {
    // Null would read as "no limit configured" downstream, which is the
    // opposite of what a sanctions hit means.
    expect(paymentLimitForRisk("high", 2000)).toBe(0);
    expect(paymentLimitForRisk("high", null)).toBe(0);
  });

  it("keeps null for a counterparty that never had a limit", () => {
    expect(paymentLimitForRisk("clear", null)).toBeNull();
    expect(paymentLimitForRisk("medium", null)).toBeNull();
  });

  it("rounds to six decimals so a tiered limit is a valid USDC amount", () => {
    expect(paymentLimitForRisk("medium", 0.0000015)).toBe(0);
    expect(paymentLimitForRisk("medium", 3)).toBe(0.75);
  });

  it("is idempotent when applied to its own output at the same tier", () => {
    // The property re-screening depends on: tiering a limit that is already
    // tiered must not tier it again.
    const once = paymentLimitForRisk("medium", 2000);
    expect(paymentLimitForRisk("medium", 2000)).toBe(once);
  });
});

describe("planScreening — first screen", () => {
  it("captures the configured limit as the baseline", () => {
    const plan = planScreening(row());
    expect(plan.firstScreen).toBe(true);
    expect(plan.baseline).toBe(2000);
    expect(plan.newLimit).toBe(2000);
    expect(plan.changed).toBe(true);
  });

  it("captures the baseline before tiering, not after", () => {
    const plan = planScreening(row({ name: "Zenith Trading LLC" }));
    expect(plan.baseline).toBe(2000);
    expect(plan.newLimit).toBe(0);
  });

  it("treats a row with no last_screened_at as unscreened even if tiered", () => {
    const plan = planScreening(row({ risk_level: "clear", last_screened_at: null }));
    expect(plan.firstScreen).toBe(true);
  });
});

describe("planScreening — re-screening is idempotent", () => {
  it("does not decay a medium-risk limit across repeated screens", () => {
    // The bug migration 0002 fixes: before the baseline column, twenty screens
    // left this counterparty on 2000 * 0.25^20, which is zero in any currency.
    const { plan, final } = rescreen(row({ name: "Wardrobe Holdings Ltd" }), 20);
    expect(plan.newLimit).toBe(500);
    expect(final.payment_limit).toBe(500);
  });

  it("does not decay a clear counterparty's limit either", () => {
    const { plan } = rescreen(row(), 20);
    expect(plan.newLimit).toBe(2000);
  });

  it("reports no change once the tier has settled", () => {
    const first = planScreening(row());
    const settled = row({
      risk_level: first.result.riskLevel,
      payment_limit: first.newLimit,
      baseline_payment_limit: first.baseline,
      last_screened_at: new Date().toISOString(),
    });
    const second = planScreening(settled);
    expect(second.changed).toBe(false);
    expect(second.firstScreen).toBe(false);
  });

  it("restores the full limit if a counterparty comes off the watchlist", () => {
    // Tiering down must be reversible, or a false positive is a life sentence.
    const flagged = row({
      name: "Wardrobe Holdings Ltd",
      risk_level: "medium",
      payment_limit: 500,
      baseline_payment_limit: 2000,
      last_screened_at: new Date().toISOString(),
    });
    const cleared = planScreening({ ...flagged, name: "Vercel Inc" });
    expect(cleared.result.riskLevel).toBe("clear");
    expect(cleared.newLimit).toBe(2000);
    expect(cleared.changed).toBe(true);
  });

  it("reports a change when a clear counterparty becomes high risk", () => {
    const clear = row({
      risk_level: "clear",
      payment_limit: 2000,
      baseline_payment_limit: 2000,
      last_screened_at: new Date().toISOString(),
    });
    const hit = planScreening({ ...clear, name: "Zenith Trading LLC" });
    expect(hit.changed).toBe(true);
    expect(hit.firstScreen).toBe(false);
    expect(hit.newLimit).toBe(0);
  });

  it("keeps a high-risk counterparty at zero without losing its baseline", () => {
    const { plan, final } = rescreen(row({ name: "Zenith Trading LLC" }), 5);
    expect(plan.newLimit).toBe(0);
    expect(final.baseline_payment_limit).toBe(2000);
  });

  it("does not invent a baseline for a client that never had a limit", () => {
    const { plan } = rescreen(row({ name: "Lumen Retail Co", payment_limit: null }), 5);
    expect(plan.baseline).toBeNull();
    expect(plan.newLimit).toBeNull();
  });

  it("accepts numeric strings, which is how Postgres returns numeric(20,6)", () => {
    const plan = planScreening(row({ payment_limit: "2000.000000" }));
    expect(plan.baseline).toBe(2000);
  });
});

describe("isScreeningDue", () => {
  const now = Date.parse("2026-09-24T12:00:00Z");
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it("is always due for an unscreened counterparty", () => {
    expect(isScreeningDue({ risk_level: "unscreened", last_screened_at: null }, now, 86_400_000)).toBe(true);
  });

  it("is always due for a row screened at an unknown time", () => {
    expect(isScreeningDue({ risk_level: "clear", last_screened_at: null }, now, 86_400_000)).toBe(true);
  });

  it("re-screens every cycle when no interval is configured", () => {
    expect(isScreeningDue({ risk_level: "clear", last_screened_at: hoursAgo(0.1) }, now, 0)).toBe(true);
  });

  it("respects a configured interval", () => {
    const fresh = { risk_level: "clear", last_screened_at: hoursAgo(1) };
    const stale = { risk_level: "clear", last_screened_at: hoursAgo(25) };
    expect(isScreeningDue(fresh, now, 24 * 3_600_000)).toBe(false);
    expect(isScreeningDue(stale, now, 24 * 3_600_000)).toBe(true);
  });

  it("is due exactly on the interval boundary", () => {
    const row = { risk_level: "clear", last_screened_at: hoursAgo(24) };
    expect(isScreeningDue(row, now, 24 * 3_600_000)).toBe(true);
  });
});

describe("rescreenIntervalMs", () => {
  const original = process.env.COMPLIANCE_RESCREEN_HOURS;
  const originalUrl = process.env.OPENSANCTIONS_API_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.COMPLIANCE_RESCREEN_HOURS;
    else process.env.COMPLIANCE_RESCREEN_HOURS = original;
    if (originalUrl === undefined) delete process.env.OPENSANCTIONS_API_URL;
    else process.env.OPENSANCTIONS_API_URL = originalUrl;
  });

  it("defaults to every cycle", () => {
    delete process.env.COMPLIANCE_RESCREEN_HOURS;
    delete process.env.OPENSANCTIONS_API_URL;
    expect(rescreenIntervalMs()).toBe(0);
  });

  it("defaults live screening to a 24-hour cadence", () => {
    delete process.env.COMPLIANCE_RESCREEN_HOURS;
    process.env.OPENSANCTIONS_API_URL = "https://yente.internal";
    expect(rescreenIntervalMs()).toBe(24 * 3_600_000);
  });

  it("reads hours from the environment", () => {
    process.env.COMPLIANCE_RESCREEN_HOURS = "24";
    expect(rescreenIntervalMs()).toBe(86_400_000);
  });

  it("falls back to every cycle on nonsense rather than skipping screening", () => {
    // Failing open on a compliance control is the wrong direction; a bad
    // value must mean "screen more", never "screen less".
    for (const bad of ["", "abc", "-5", "0"]) {
      process.env.COMPLIANCE_RESCREEN_HOURS = bad;
      expect(rescreenIntervalMs()).toBe(0);
    }
  });
});
