import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvePlanAction, type PlanActionResult } from "@/app/actions/payment-plan";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * The payment plan's Approve and Approve all shown (payment plan design P9, P10), against a real `inOrg`: `authorize`
 * and the command are stand-ins (tests/commands-payment-plan.test.ts proves the command), so this holds the action to
 * its gate and to reading the form exactly.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000d1d",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e6",
}));
const INVOICE_A = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const INVOICE_B = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000b2";

vi.mock("server-only", () => ({}));
const { revalidatePathMock, authorizeMock, approvePlanLinesMock } = vi.hoisted(() => ({
  revalidatePathMock: vi.fn(),
  authorizeMock: vi.fn(),
  approvePlanLinesMock: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/commands/payment-plan", () => ({ approvePlanLines: approvePlanLinesMock }));

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgRow = () => ({ id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null });
const run = <T,>(fn: () => Promise<T>): Promise<T> => {
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow() } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
};
const member = (role: "owner" | "admin" | "approver" | "viewer") => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "live" as const, role },
});

const INITIAL: PlanActionResult = { ok: false, message: "" };
function form(lines: string[], planFingerprint = "plan0fp"): FormData {
  const formData = new FormData();
  formData.set("orgSlug", "northstar");
  formData.set("planFingerprint", planFingerprint);
  for (const line of lines) formData.append("line", line);
  return formData;
}

beforeEach(() => vi.clearAllMocks());

describe("approvePlanAction", () => {
  it("asks for approval.decide first, and stops at a refusal", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    const result = await approvePlanAction(INITIAL, form([`${INVOICE_A}:abc123`]));
    expect(authorizeMock).toHaveBeenCalledWith("northstar", "approval.decide");
    expect(result).toEqual({ ok: false, message: "Your role in this workspace (viewer) cannot do that." });
    expect(approvePlanLinesMock).not.toHaveBeenCalled();
  });

  it("hands the plan's fingerprint and every line shown to the command, and refreshes the pages after a move", async () => {
    authorizeMock.mockResolvedValueOnce(member("approver"));
    approvePlanLinesMock.mockResolvedValueOnce({ ok: true, message: "Moved 2 payments.", results: [] });
    const result = await run(() => approvePlanAction(INITIAL, form([`${INVOICE_A}:abc123`, `${INVOICE_B}:def456`])));
    expect(approvePlanLinesMock).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, role: "approver", surface: { kind: "console" } }), {
      planFingerprint: "plan0fp",
      lines: [
        { invoiceId: INVOICE_A, fingerprint: "abc123" },
        { invoiceId: INVOICE_B, fingerprint: "def456" },
      ],
    });
    expect(result).toEqual({ ok: true, message: "Moved 2 payments." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });

  it("refuses a form that is not a plan's, without calling the command", async () => {
    for (const bad of [form([]), form(["not-a-uuid:abc"]), form([`${INVOICE_A}:ABC!`]), form([`${INVOICE_A}:abc:extra`]), form([`${INVOICE_A}:abc`], "")]) {
      authorizeMock.mockResolvedValueOnce(member("owner"));
      expect(await run(() => approvePlanAction(INITIAL, bad))).toEqual({ ok: false, message: "Reload the page and try again." });
    }
    expect(approvePlanLinesMock).not.toHaveBeenCalled();
  });

  it("passes a refusal on in the command's words, refreshing nothing when nothing changed", async () => {
    authorizeMock.mockResolvedValueOnce(member("admin"));
    approvePlanLinesMock.mockResolvedValueOnce({ ok: false, code: "cycle_running", message: "A cycle is running. Try again in a minute, once it has finished." });
    const result = await run(() => approvePlanAction(INITIAL, form([`${INVOICE_A}:abc123`])));
    expect(result).toEqual({ ok: false, message: "A cycle is running. Try again in a minute, once it has finished." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("refreshes the page after a refusal that says the plan shown is out of date", async () => {
    authorizeMock.mockResolvedValueOnce(member("admin"));
    approvePlanLinesMock.mockResolvedValueOnce({
      ok: false,
      code: "stale",
      message: "The balance was read from the chain 30 minutes ago. Refresh it to approve the plan.",
      changed: true,
    });
    const result = await run(() => approvePlanAction(INITIAL, form([`${INVOICE_A}:abc123`])));
    expect(result).toEqual({ ok: false, message: "The balance was read from the chain 30 minutes ago. Refresh it to approve the plan." });
    expect(revalidatePathMock).toHaveBeenCalled();
  });
});
