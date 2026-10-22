import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerAddressChangeAction } from "@/app/address-change/[token]/actions";
import { unfreezeCounterpartyAction } from "@/app/actions/intake";
import { UnfreezeError } from "@/lib/address-change-check";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The two actions of "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC3, AC4): the
 * payee's answer, which needs no session and says only fixed sentences, with the owners' email after it; and an owner's
 * or admin's unfreeze, with its note, in a real `inOrg`.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e6",
}));
const COUNTERPARTY_ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const { afterMock } = vi.hoisted(() => ({ afterMock: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: afterMock }));
const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
const { answerMock, unfreezeMock } = vi.hoisted(() => ({ answerMock: vi.fn(), unfreezeMock: vi.fn() }));
vi.mock("@/lib/address-change-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/address-change-check")>()),
  answerAddressChange: answerMock,
  unfreezeCounterparty: unfreezeMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

const INITIAL = { ok: false, message: "" };

describe("the payee's answer (AC3)", () => {
  it("passes the token and the answer, and tells the owners after the payee's page", async () => {
    answerMock.mockResolvedValueOnce("frozen");
    const result = await answerAddressChangeAction(INITIAL, form({ token: "vxw_x", answer: "not_me" }));
    expect(answerMock).toHaveBeenCalledWith("vxw_x", true, { defer: expect.any(Function) });
    expect(result).toMatchObject({ ok: true, outcome: "frozen" });
    expect(result.message).toContain("Payments to the new address are stopped");
    const options = answerMock.mock.calls[0][2] as { defer: (work: () => Promise<unknown>) => void };
    const work = async () => undefined;
    options.defer(work);
    expect(afterMock).toHaveBeenCalledWith(work);
  });

  it("says each outcome in a fixed sentence, and nothing of a failure", async () => {
    answerMock.mockResolvedValueOnce("confirmed");
    expect((await answerAddressChangeAction(INITIAL, form({ token: "t", answer: "me" }))).message).toBe(
      "Thank you. You told them you made this change. Nothing else is needed from you."
    );
    expect(answerMock).toHaveBeenLastCalledWith("t", false, expect.anything());
    answerMock.mockResolvedValueOnce("disputed");
    expect((await answerAddressChangeAction(INITIAL, form({ token: "t", answer: "not_me" }))).message).toContain("already been changed again");
    answerMock.mockResolvedValueOnce("not_valid");
    expect((await answerAddressChangeAction(INITIAL, form({ token: "t", answer: "not_me" }))).message).toContain("This link is no longer valid.");
    answerMock.mockRejectedValueOnce(new Error("relation does not exist, token vxw_secret"));
    const failed = await answerAddressChangeAction(INITIAL, form({ token: "t", answer: "not_me" }));
    expect(failed).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
  });
});

describe("unfreezing (AC4)", () => {
  function allow(role: "owner" | "admin" | "approver") {
    authorizeMock.mockResolvedValueOnce({ ok: true, user: { id: USER, email: null }, membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live", role } });
  }
  const run = <T,>(fn: () => Promise<T>) => {
    const fake = fakeSupabase((request) =>
      request.path === "/rest/v1/orgs"
        ? { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
        : { body: [] }
    );
    return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  };
  const unfreezeForm = (note: string) => {
    const data = form({ counterpartyId: COUNTERPARTY_ID, note });
    data.set("orgSlug", "northstar");
    return data;
  };

  it("asks for records.write, and unfreezes as the signed-in owner or admin with their note", async () => {
    allow("admin");
    unfreezeMock.mockResolvedValueOnce(undefined);
    const result = await run(() => unfreezeCounterpartyAction(INITIAL, unfreezeForm("Called them on the number we had")));
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(unfreezeMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, role: "admin", counterpartyId: COUNTERPARTY_ID, note: "Called them on the number we had" });
    expect(result).toEqual({ ok: true, message: "Unfrozen. Its address still needs confirming before it is paid." });
  });

  it("says why it was refused", async () => {
    allow("owner");
    unfreezeMock.mockRejectedValueOnce(new UnfreezeError("changer"));
    expect((await run(() => unfreezeCounterpartyAction(INITIAL, unfreezeForm("x x x")))).message).toBe(
      "You made the change this payee disputed, so another owner or admin unfreezes it."
    );
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });
    expect(await run(() => unfreezeCounterpartyAction(INITIAL, unfreezeForm("x x x")))).toEqual({ ok: false, message: "Only an owner or admin can do that." });
  });
});
