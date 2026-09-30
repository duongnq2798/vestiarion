import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { loadSampleDataAction, removeSampleDataAction, type SampleDataActionResult } from "@/app/actions/sample-data";
import { SampleDataError } from "@/lib/sample-data";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/sample-data.ts` against a real `inOrg`, the same shape as
 * tests/webhooks-actions.test.ts: `server-only`, `authorize` and the library
 * calls are stand-ins, proven elsewhere.
 */

const { ORG, USER } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c0c",
  USER: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000fc",
}));

vi.mock("server-only", () => ({}));

const { revalidatePathMock } = vi.hoisted(() => ({ revalidatePathMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const { authorizeMock } = vi.hoisted(() => ({ authorizeMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));

const { loadMock, removeMock } = vi.hoisted(() => ({ loadMock: vi.fn(), removeMock: vi.fn() }));
vi.mock("@/lib/sample-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sample-data")>();
  return { ...actual, loadSampleData: loadMock, removeSampleData: removeMock };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

const allowed = () => ({
  ok: true,
  user: { id: USER, email: null },
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox" as const, role: "admin" as const },
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: SampleDataActionResult = { ok: false, message: "" };

function form(): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  return data;
}

describe.each([
  ["loadSampleDataAction", loadSampleDataAction, loadMock],
  ["removeSampleDataAction", removeSampleDataAction, removeMock],
] as const)("%s", (_name, action, work) => {
  it("asks for records.write and does nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You cannot do this." });

    const result = await action(INITIAL, form());

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "records.write");
    expect(result).toEqual({ ok: false, message: "You cannot do this." });
    expect(work).not.toHaveBeenCalled();
  });

  it("shows a SampleDataError's own message", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    work.mockRejectedValueOnce(new SampleDataError("cycle_running"));

    const result = await run(() => action(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "A cycle is running. Try again in a minute, once it has finished." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("hides any other error behind a generic message", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    work.mockRejectedValueOnce(new Error("relation does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(() => action(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });
});

describe("loadSampleDataAction", () => {
  it("loads as the signed-in person, refreshes the workspace's pages and says what to do next", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    loadMock.mockResolvedValueOnce({ counterparties: 6, invoices: 6, milestones: 2 });

    const result = await run(() => loadSampleDataAction(INITIAL, form()));

    expect(loadMock).toHaveBeenCalledWith({ actorId: USER });
    expect(result).toEqual({
      ok: true,
      message: "Sample data loaded: 6 counterparties, 6 invoices and 2 milestones. The agent will decide on them within a minute.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });
});

describe("removeSampleDataAction", () => {
  it("removes as the signed-in person and says what went", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    removeMock.mockResolvedValueOnce({ counterparties: 6, invoices: 7, milestones: 2, paymentIntents: 3 });

    const result = await run(() => removeSampleDataAction(INITIAL, form()));

    expect(removeMock).toHaveBeenCalledWith({ actorId: USER });
    expect(result).toEqual({
      ok: true,
      message: "Sample data removed: 6 counterparties, with 7 invoices and 2 milestones. The ledger keeps its entries.",
    });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });
});
