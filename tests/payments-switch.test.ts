import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  assertPaymentsEnabled,
  forgetPaymentsSwitch,
  paymentsDisabled,
  PaymentsDisabledError,
  paymentsHold,
  paymentsSwitchForPages,
  PAYMENTS_OFF,
  readPaymentsSwitch,
  setPaymentsSwitch,
} from "@/lib/payments-switch";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

/** The database's switch, as PostgREST answers a read of platform_controls (migration 0074). */
function database(row: FakeReply | { payments_disabled_at: string | null; payments_disabled_reason: string | null } | null) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/platform_controls") return { body: [] };
    if (request.method === "PATCH") return { body: [] };
    if (row && "status" in row) return row as FakeReply;
    return { body: row };
  });
}

function inScope<T>(fake: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>, config: VestiarionConfig = base): Promise<T> {
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

beforeEach(() => forgetPaymentsSwitch());

const reads = (fake: ReturnType<typeof fakeSupabase>) => fake.requests.filter((request) => request.path === "/rest/v1/platform_controls" && request.method === "GET").length;

/** The platform's stop switch (payment safety S1, S7): the deployment's PAYMENTS_DISABLED, or the database's row. */
describe("the platform's payment switch", () => {
  it("refuses while the deployment has payments switched off, in words a person reads, without reading the database", async () => {
    const fake = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(
      fake,
      async () => {
        expect(await paymentsDisabled()).toBe(true);
        await expect(assertPaymentsEnabled()).rejects.toThrow(PaymentsDisabledError);
        await expect(assertPaymentsEnabled()).rejects.toThrow("Payments are switched off for every workspace right now.");
      },
      { ...base, paymentsDisabled: true }
    );
    expect(reads(fake)).toBe(0);
    expect(PAYMENTS_OFF).toBe("Payments are switched off for every workspace right now.");
  });

  it("refuses while the database's switch is off, which every running deployment reads (S7)", async () => {
    const fake = database({ payments_disabled_at: "2026-10-05T05:00:00Z", payments_disabled_reason: "Incident 7" });
    await inScope(fake, async () => {
      expect(await paymentsDisabled()).toBe(true);
      await expect(assertPaymentsEnabled()).rejects.toBeInstanceOf(PaymentsDisabledError);
    });
  });

  it("lets payments through when both are on", async () => {
    await inScope(database({ payments_disabled_at: null, payments_disabled_reason: null }), async () => {
      expect(await paymentsDisabled()).toBe(false);
      await expect(assertPaymentsEnabled()).resolves.toBeUndefined();
    });
  });

  it("counts a switch it cannot read as off: money never moves on could not tell", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await inScope(database({ status: 500, body: { message: "connection reset" } }), async () => {
      expect(await paymentsDisabled()).toBe(true);
    });
    expect(error).toHaveBeenCalledWith("payments switch: not read", "connection reset");
    error.mockRestore();
  });

  it("counts a switch table not created yet as on, so a migration not yet run never stops every payment", async () => {
    const missing = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.platform_controls' in the schema cache" } };
    await inScope(database(missing), async () => {
      expect(await paymentsDisabled()).toBe(false);
    });
  });

  it("reads the database at most every 10 seconds", async () => {
    const fake = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(fake, async () => {
      await paymentsDisabled(1_000);
      await paymentsDisabled(11_000);
      expect(reads(fake)).toBe(1);
      await paymentsDisabled(11_001);
      expect(reads(fake)).toBe(2);
    });
  });
});

describe("the switch on every page (S5)", () => {
  it("says it is off, with the reason the database gives", async () => {
    const state = await inScope(database({ payments_disabled_at: "2026-10-05T05:00:00Z", payments_disabled_reason: "Incident 7" }), () => paymentsSwitchForPages());
    expect(state).toEqual({ off: true, reason: "Incident 7" });
  });

  it("shows nothing when the switch cannot be read: it never takes a page down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = await inScope(database({ status: 500, body: { message: "connection reset" } }), () => paymentsSwitchForPages());
    // No banner; the header says it is not known, since every payment gate refuses on the same failure.
    expect(state).toEqual({ off: false, reason: null, unread: true });
    error.mockRestore();
  });
});

describe("setting the switch (npm run payments)", () => {
  it("records when payments were switched off, and why, and clears both when they are back on", async () => {
    const fake = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(fake, () => setPaymentsSwitch(true, "  Incident 7  "));
    await inScope(fake, () => setPaymentsSwitch(false, null));
    const [off, on] = fake.requests.filter((request) => request.method === "PATCH").map((request) => request.body as Record<string, unknown>);
    expect(off.payments_disabled_reason).toBe("Incident 7");
    expect(typeof off.payments_disabled_at).toBe("string");
    expect(on).toMatchObject({ payments_disabled_at: null, payments_disabled_reason: null });
  });
});

describe("reading the switch for npm run payments", () => {
  it("says which half stopped payments, and throws when the database cannot be read", async () => {
    expect(await inScope(database(null), () => readPaymentsSwitch(), { ...base, paymentsDisabled: true })).toEqual({ off: true, reason: "PAYMENTS_DISABLED is set" });
    expect(await inScope(database({ payments_disabled_at: "2026-10-05T05:00:00Z", payments_disabled_reason: "Incident 7" }), () => readPaymentsSwitch())).toEqual({
      off: true,
      reason: "Incident 7",
    });
    await expect(inScope(database({ status: 500, body: { message: "connection reset" } }), () => readPaymentsSwitch())).rejects.toThrow("connection reset");
  });
});

describe("a workspace's network hold (mainnet go-live M4)", () => {
  const NOT_LIVE = "This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.";
  const held = { ...base, chain: { ...base.chain, networkHold: NOT_LIVE } };

  it("refuses with the hold's reason, before reading the database's switch", async () => {
    const fake = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(
      fake,
      async () => {
        expect(await paymentsHold()).toBe(NOT_LIVE);
        expect(await paymentsDisabled()).toBe(true);
        await expect(assertPaymentsEnabled()).rejects.toThrow(NOT_LIVE);
        await expect(assertPaymentsEnabled()).rejects.toBeInstanceOf(PaymentsDisabledError);
      },
      held
    );
    expect(reads(fake)).toBe(0);
  });

  it("is the platform's reason when there is no hold, and nothing when payments are on", async () => {
    const off = database({ payments_disabled_at: "2026-10-05T05:00:00Z", payments_disabled_reason: "Incident 7" });
    await inScope(off, async () => expect(await paymentsHold()).toBe(PAYMENTS_OFF));
    forgetPaymentsSwitch();
    const on = database({ payments_disabled_at: null, payments_disabled_reason: null });
    await inScope(on, async () => expect(await paymentsHold()).toBeNull());
    await inScope(on, async () => expect(await paymentsHold()).toBe(PAYMENTS_OFF), { ...base, paymentsDisabled: true });
  });

  it("keeps the platform's message for an error built without a reason", () => {
    expect(new PaymentsDisabledError().message).toBe(PAYMENTS_OFF);
    expect(new PaymentsDisabledError(NOT_LIVE).message).toBe(NOT_LIVE);
  });
});
