import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import {
  confirmCounterpartyAddressAction,
  updateCounterpartyAddressAction,
  updateCounterpartyLimitAction,
  updateCounterpartyNoticeEmailAction,
  type IntakeActionResult,
} from "@/app/actions/intake";
import { CounterpartyLimitError } from "@/lib/counterparty-limit";
import { CounterpartyAddressError } from "@/lib/counterparty-address";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The address actions in `src/app/actions/intake.ts` against a real `inOrg`,
 * the same shape as `tests/approvals-actions.test.ts`: `server-only`,
 * `authorize` and the library's two writes are stand-ins — the library is
 * proven against PostgREST in tests/counterparty-address.test.ts — while
 * `inOrg` and its org lookup are real.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d0e",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e6",
}));

const COUNTERPARTY_ID = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const ADDRESS = "0x2222222222222222222222222222222222222222";

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { changeMock, confirmMock } = vi.hoisted(() => ({ changeMock: vi.fn(), confirmMock: vi.fn() }));
vi.mock("@/lib/counterparty-address", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-address")>()),
  changeCounterpartyAddress: changeMock,
  confirmCounterpartyAddress: confirmMock,
}));

const { changeLimitMock, changeNoticeMock } = vi.hoisted(() => ({ changeLimitMock: vi.fn(), changeNoticeMock: vi.fn() }));
vi.mock("@/lib/payment-notices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/payment-notices")>()),
  changeCounterpartyNoticeEmail: changeNoticeMock,
}));
vi.mock("@/lib/counterparty-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-limit")>()),
  changeCounterpartyLimit: changeLimitMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

function allow(role: "owner" | "admin" | "approver") {
  authorizeMock.mockResolvedValueOnce({
    ok: true,
    user: { id: USER, email: null },
    membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live", role },
  });
}

function run<T>(fn: () => Promise<T>): Promise<T> {
  const fake = fakeSupabase((request) =>
    request.path === "/rest/v1/orgs"
      ? { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } }
      : { body: [] }
  );
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

function form(fields: Record<string, string>): FormData {
  const formData = new FormData();
  formData.set("orgSlug", "northstar");
  for (const [key, value] of Object.entries(fields)) formData.set(key, value);
  return formData;
}

const INITIAL: IntakeActionResult = { ok: false, message: "" };

describe("updateCounterpartyAddressAction", () => {
  it("asks for records.write, and changes nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });

    const result = await run(() => updateCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(result).toEqual({ ok: false, message: "Only an owner or admin can do that." });
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("changes the address as the signed-in person, says the next payment waits, and refreshes the pages", async () => {
    allow("admin");
    changeMock.mockResolvedValueOnce({ name: "Acme", from: null, to: ADDRESS });

    const result = await run(() => updateCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(changeMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY_ID, raw: ADDRESS });
    expect(result).toEqual({ ok: true, message: "Acme's address changed. The next payment to it waits for a person to approve it." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("says so when the address was cleared", async () => {
    allow("owner");
    changeMock.mockResolvedValueOnce({ name: "Acme", from: ADDRESS, to: null });

    const result = await run(() => updateCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: "" })));

    expect(result).toEqual({ ok: true, message: "Acme's address cleared." });
  });

  it("refuses a malformed counterparty id without calling the library", async () => {
    allow("owner");

    const result = await run(() => updateCounterpartyAddressAction(INITIAL, form({ counterpartyId: "nope", address: ADDRESS })));

    expect(result).toEqual({ ok: false, message: "Counterparty not found." });
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("shows the library's own refusal", async () => {
    allow("owner");
    changeMock.mockRejectedValueOnce(new CounterpartyAddressError("conflict"));

    const result = await run(() => updateCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(result).toEqual({ ok: false, message: "Someone else changed this address a moment ago." });
  });

  it("keeps any other failure out of the message", async () => {
    allow("owner");
    changeMock.mockRejectedValueOnce(new Error("connection reset by 10.0.0.4"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(() => updateCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });
});

describe("confirmCounterpartyAddressAction", () => {
  it("asks for approval.decide, and confirms nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You cannot decide approvals here." });

    const result = await run(() => confirmCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "approval.decide");
    expect(result.ok).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("confirms the address the page showed, as the signed-in person", async () => {
    allow("approver");
    confirmMock.mockResolvedValueOnce(true);

    const result = await run(() => confirmCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(confirmMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY_ID, shownAddress: ADDRESS, via: "confirm" });
    expect(result).toEqual({ ok: true, message: "Address confirmed. Payments to it are decided as usual again." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("says when there was nothing to confirm", async () => {
    allow("approver");
    confirmMock.mockResolvedValueOnce(false);

    const result = await run(() => confirmCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(result).toEqual({ ok: true, message: "This address is already confirmed." });
  });

  it("shows a stale page's refusal", async () => {
    allow("approver");
    confirmMock.mockRejectedValueOnce(new CounterpartyAddressError("stale"));

    const result = await run(() => confirmCounterpartyAddressAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, address: ADDRESS })));

    expect(result).toEqual({
      ok: false,
      message: "This counterparty's address changed after this page loaded. Check the new address and try again.",
    });
  });
});

describe("updateCounterpartyLimitAction", () => {
  it("asks for records.write, and changes nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });

    const result = await run(() => updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, paymentLimit: "10" })));

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(result.ok).toBe(false);
    expect(changeLimitMock).not.toHaveBeenCalled();
  });

  it("changes the limit as the signed-in person, and refreshes the pages", async () => {
    allow("admin");
    changeLimitMock.mockResolvedValueOnce({ name: "Centronex", from: 2, to: 10, current: 10 });

    const result = await run(() => updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, paymentLimit: "10" })));

    expect(changeLimitMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY_ID, raw: "10" });
    expect(result).toEqual({ ok: true, message: "Centronex's payment limit is now 10 USDC." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("says what screening allows when it is less than the limit set", async () => {
    allow("owner");
    changeLimitMock.mockResolvedValueOnce({ name: "Centronex", from: 2, to: 100, current: 25 });

    const result = await run(() => updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, paymentLimit: "100" })));

    expect(result.message).toBe("Centronex's payment limit is now 100 USDC; screening allows 25 USDC for its risk.");
  });

  it("shows the library's own refusal", async () => {
    allow("owner");
    changeLimitMock.mockRejectedValueOnce(new CounterpartyLimitError("required"));

    const result = await run(() => updateCounterpartyLimitAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, paymentLimit: "" })));

    expect(result).toEqual({ ok: false, message: "A vendor or contractor needs a payment limit: without one, the agent could pay any amount." });
  });
});

describe("updateCounterpartyNoticeEmailAction", () => {
  it("asks for records.write, and changes nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Only an owner or admin can do that." });

    const result = await run(() => updateCounterpartyNoticeEmailAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, noticeEmail: "linh@example.com" })));

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(result.ok).toBe(false);
    expect(changeNoticeMock).not.toHaveBeenCalled();
  });

  it("sets the address, trimmed, and says where notices go", async () => {
    allow("admin");
    changeNoticeMock.mockResolvedValueOnce({ name: "Centronex", email: "ap@centronex.example" });

    const result = await run(() => updateCounterpartyNoticeEmailAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, noticeEmail: "  ap@centronex.example " })));

    expect(changeNoticeMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY_ID, email: "ap@centronex.example" });
    expect(result).toEqual({ ok: true, message: "Centronex is emailed at ap@centronex.example when it is paid." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("turns notices off when the field is empty", async () => {
    allow("owner");
    changeNoticeMock.mockResolvedValueOnce({ name: "Centronex", email: null });

    const result = await run(() => updateCounterpartyNoticeEmailAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, noticeEmail: "" })));

    expect(changeNoticeMock).toHaveBeenCalledWith({ actorId: USER, counterpartyId: COUNTERPARTY_ID, email: null });
    expect(result).toEqual({ ok: true, message: "Centronex is no longer emailed when it is paid." });
  });

  it("refuses an address that does not look right, changing nothing", async () => {
    allow("owner");

    const result = await run(() => updateCounterpartyNoticeEmailAction(INITIAL, form({ counterpartyId: COUNTERPARTY_ID, noticeEmail: "not-an-email" })));

    expect(result).toEqual({ ok: false, message: "That email address does not look right" });
    expect(changeNoticeMock).not.toHaveBeenCalled();
  });
});
