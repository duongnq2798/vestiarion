import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { DismissalError, dismissScreeningMatch } from "@/lib/screening-dismissal";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Not this person (docs/superpowers/specs/2026-10-01-dismiss-screening-match-design.md): a person
 * dismisses the entity a counterparty's current verdict matched, with a reason; it is recorded and
 * signed, and the counterparty is screened again at once. Screening and the ledger are faked.
 */

const { screenMock, ledgerMock } = vi.hoisted(() => ({ screenMock: vi.fn(), ledgerMock: vi.fn() }));
vi.mock("@/lib/compliance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance")>()),
  screenCounterparty: screenMock,
}));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const CP = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";

const COUNTERPARTY = {
  id: CP,
  name: "Quoc Duong",
  risk_level: "medium",
  risk_notes: "Dương Trung Quốc matched at 0.909 (role.pep, role.pol)",
  risk_entity_id: "Q-PEP",
};

let fake: ReturnType<typeof fakeSupabase>;
function workspace(over: { counterparty?: unknown; insert?: FakeReply } = {}) {
  return (request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: over.counterparty === undefined ? COUNTERPARTY : over.counterparty };
    if (request.path === "/rest/v1/screening_dismissals" && request.method === "POST") return over.insert ?? { status: 201, body: null };
    return { body: [] };
  };
}
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
const dismiss = (over: Partial<{ matchedEntityId: string; reason: string }> = {}) =>
  run(() => dismissScreeningMatch({ actorId: USER, counterpartyId: CP, matchedEntityId: "Q-PEP", reason: "Our freelancer, not the politician", ...over }));

beforeEach(() => {
  fake = fakeSupabase(workspace());
  screenMock.mockReset().mockResolvedValue({ riskLevel: "clear", newPaymentLimit: 1 });
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("dismissScreeningMatch", () => {
  it("records the dismissal for this counterparty, entity and name, with who and why", async () => {
    await dismiss();
    const insert = fake.requests.find((r) => r.path === "/rest/v1/screening_dismissals" && r.method === "POST")!;
    expect(insert.body).toMatchObject({
      org_id: ORG,
      counterparty_id: CP,
      matched_entity_id: "Q-PEP",
      matched_caption: "Dương Trung Quốc",
      matched_score: 0.909,
      screened_name: "Quoc Duong",
      reason: "Our freelancer, not the politician",
      dismissed_by: USER,
    });
  });

  it("signs it in the ledger as the person's decision", async () => {
    await dismiss();
    expect(ledgerMock).toHaveBeenCalledWith({
      actor: "human",
      domain: "compliance",
      action: "screening_match_dismissed",
      summary: "Dismissed a screening match for Quoc Duong: not the same person as Dương Trung Quốc",
      detail: {
        by: USER,
        counterpartyId: CP,
        matchedEntityId: "Q-PEP",
        matchedCaption: "Dương Trung Quốc",
        matchedScore: 0.909,
        screenedName: "Quoc Duong",
        reason: "Our freelancer, not the politician",
      },
    });
  });

  it("screens the counterparty again at once and says what it is now", async () => {
    expect(await dismiss()).toEqual({ name: "Quoc Duong", rescreened: true, riskLevel: "clear", paymentLimit: 1 });
    expect(screenMock).toHaveBeenCalledWith(CP);
  });

  it("keeps the dismissal when screening cannot be reached, for the next cycle to apply", async () => {
    screenMock.mockRejectedValueOnce(new Error("OpenSanctions screening failed with HTTP 503"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await dismiss()).toEqual({ name: "Quoc Duong", rescreened: false, riskLevel: "medium", paymentLimit: null });
    expect(ledgerMock).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("refuses a page that showed another match, recording nothing (R4)", async () => {
    await expect(dismiss({ matchedEntityId: "Q-OLD" })).rejects.toMatchObject({ code: "stale" });
    expect(fake.requests.some((r) => r.path === "/rest/v1/screening_dismissals")).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("refuses without a reason, and for a counterparty it cannot find", async () => {
    await expect(dismiss({ reason: " no " })).rejects.toMatchObject({ code: "invalid" });
    fake = fakeSupabase(workspace({ counterparty: null }));
    await expect(dismiss()).rejects.toMatchObject({ code: "not_found" });
  });

  it("says when that match was already dismissed", async () => {
    fake = fakeSupabase(workspace({ insert: { status: 409, body: { code: "23505", message: "duplicate key value violates unique constraint" } } }));
    const error = await dismiss().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DismissalError);
    expect(error).toMatchObject({ code: "already" });
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});
