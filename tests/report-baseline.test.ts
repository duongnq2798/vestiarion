import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { answerBaseline, readBaseline } from "@/lib/report-baseline";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * An owner's answer about how bills were handled before Vestiarion (docs/superpowers/specs/2026-10-10-shared-report-
 * design.md S9, S13): two whole numbers, checked; kept as a new row each time, the newest read; each a signed entry;
 * before migration 0095 runs, reading says so and answering refuses.
 */

const { appendBestEffort, canSign } = vi.hoisted(() => ({ appendBestEffort: vi.fn(async () => undefined), canSign: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), assertLedgerCanSign: canSign }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const MISSING: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.report_baselines' in the schema cache" } };

function database(reply: (request: RecordedRequest) => FakeReply) {
  const fake = fakeSupabase(reply);
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: OWNER }), fn);
  return { fake, run };
}

const inserted = (request: RecordedRequest): FakeReply => {
  const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
  const made = { id: "base-1", answered_at: "2026-10-11T09:00:00.000Z", ...(request.body as Record<string, unknown>) };
  return { status: 201, body: wantsObject ? made : [made] };
};

beforeEach(() => {
  appendBestEffort.mockClear();
  canSign.mockReset();
});

describe("answerBaseline", () => {
  it("keeps the answer with who gave it, then signs it", async () => {
    const { fake, run } = database(inserted);
    const answer = await run(() => answerBaseline({ actorId: OWNER, minutesPerBill: "25", peoplePerBill: "2" }));
    expect(fake.requests[0]).toMatchObject({ method: "POST", path: "/rest/v1/report_baselines" });
    expect(fake.requests[0].body).toEqual({ org_id: ORG, minutes_per_bill: 25, people_per_bill: 2, answered_by: OWNER });
    expect(answer).toEqual({ id: "base-1", minutesPerBill: 25, peoplePerBill: 2, answeredBy: OWNER, answeredAt: "2026-10-11T09:00:00.000Z" });
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "report_baseline_answered",
      summary: "Answered how bills were handled before Vestiarion: 25 minutes a bill, 2 people",
      detail: { by: OWNER, baselineId: "base-1", minutesPerBill: 25, peoplePerBill: 2 },
    });
    expect(canSign).toHaveBeenCalled();
  });

  it("takes thousands written with a comma, and says one person and one minute plainly", async () => {
    const { fake, run } = database(inserted);
    await run(() => answerBaseline({ actorId: OWNER, minutesPerBill: " 1,500 ", peoplePerBill: 1 }));
    expect(fake.requests[0].body).toMatchObject({ minutes_per_bill: 1500, people_per_bill: 1 });
    expect(appendBestEffort.mock.calls[0]).toMatchObject([ORG, { summary: "Answered how bills were handled before Vestiarion: 1,500 minutes a bill, 1 person" }]);
  });

  it.each([
    [{ minutesPerBill: "0", peoplePerBill: "1" }, "minutes"],
    [{ minutesPerBill: "6001", peoplePerBill: "1" }, "minutes"],
    [{ minutesPerBill: "12.5", peoplePerBill: "1" }, "minutes"],
    [{ minutesPerBill: "", peoplePerBill: "1" }, "minutes"],
    [{ minutesPerBill: "ten", peoplePerBill: "1" }, "minutes"],
    [{ minutesPerBill: "10", peoplePerBill: "0" }, "people"],
    [{ minutesPerBill: "10", peoplePerBill: "101" }, "people"],
    [{ minutesPerBill: "10", peoplePerBill: "1,5" }, "people"],
  ])("refuses %j before anything is written", async (fields, code) => {
    const { fake, run } = database(inserted);
    await expect(run(() => answerBaseline({ actorId: OWNER, ...fields }))).rejects.toMatchObject({ code });
    expect(fake.requests).toHaveLength(0);
  });

  it("says so before migration 0095 runs", async () => {
    const { run } = database(() => MISSING);
    await expect(run(() => answerBaseline({ actorId: OWNER, minutesPerBill: "20", peoplePerBill: "2" }))).rejects.toMatchObject({
      code: "not_ready",
      message: "Your answer is not set up on this deployment yet.",
    });
    expect(appendBestEffort).not.toHaveBeenCalled();
  });
});

describe("readBaseline", () => {
  it("reads the newest answer", async () => {
    const { fake, run } = database(() => ({
      body: [{ id: "base-2", minutes_per_bill: 30, people_per_bill: 3, answered_by: OWNER, answered_at: "2026-10-11T09:00:00.000Z" }],
    }));
    await expect(run(() => readBaseline(db()))).resolves.toEqual({
      available: true,
      answer: { id: "base-2", minutesPerBill: 30, peoplePerBill: 3, answeredBy: OWNER, answeredAt: "2026-10-11T09:00:00.000Z" },
    });
    expect(fake.requests[0].params.get("order")).toBe("answered_at.desc,id.desc");
    expect(fake.requests[0].params.get("limit")).toBe("1");
  });

  it("answers none given, and not available before migration 0095 runs", async () => {
    await expect(database(() => ({ body: [] })).run(() => readBaseline(db()))).resolves.toEqual({ available: true, answer: null });
    await expect(database(() => MISSING).run(() => readBaseline(db()))).resolves.toEqual({ available: false });
  });
});
