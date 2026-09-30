import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { rotateLedgerKeyAction, type LedgerKeyActionResult } from "@/app/actions/ledger-key";
import { LedgerKeyError } from "@/lib/platform/ledger-key";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * `src/app/actions/ledger-key.ts` against a real `inOrg`, the same shape as
 * tests/sample-data-actions.test.ts: `server-only`, `authorize` and the
 * library call are stand-ins, proven elsewhere (tests/ledger-key.test.ts).
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

const { rotateMock } = vi.hoisted(() => ({ rotateMock: vi.fn() }));
vi.mock("@/lib/platform/ledger-key", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/platform/ledger-key")>();
  return { ...actual, rotateLedgerKey: rotateMock };
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
  membership: { orgId: ORG, slug: "northstar", name: "Northstar", mode: "sandbox" as const, role: "owner" as const },
});

function run<T>(fn: () => Promise<T>): Promise<T> {
  const orgRow = { id: ORG, slug: "northstar", name: "Northstar", mode: "sandbox", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null };
  const fake = fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: orgRow } : { body: [] }));
  return runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
}

const INITIAL: LedgerKeyActionResult = { ok: false, message: "" };

function form(): FormData {
  const data = new FormData();
  data.set("orgSlug", "northstar");
  return data;
}

describe("rotateLedgerKeyAction", () => {
  it("asks for org.administer and does nothing when refused", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You cannot do this." });

    const result = await rotateLedgerKeyAction(INITIAL, form());

    expect(authorizeMock).toHaveBeenCalledWith("northstar", "org.administer");
    expect(result).toEqual({ ok: false, message: "You cannot do this." });
    expect(rotateMock).not.toHaveBeenCalled();
  });

  it("shows a LedgerKeyError's own message", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    rotateMock.mockRejectedValueOnce(new LedgerKeyError("cycle_running"));

    const result = await run(() => rotateLedgerKeyAction(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "A cycle is running. Try again in a minute, once it has finished." });
    expect(revalidatePathMock).not.toHaveBeenCalled();
  });

  it("hides any other error behind a generic message", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    rotateMock.mockRejectedValueOnce(new Error("relation does not exist"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await run(() => rotateLedgerKeyAction(INITIAL, form()));

    expect(result).toEqual({ ok: false, message: "That did not work. Try again in a moment." });
    logged.mockRestore();
  });

  it("rotates as the signed-in person, refreshes the workspace's pages and says which key retired and which now signs", async () => {
    authorizeMock.mockResolvedValueOnce(allowed());
    rotateMock.mockResolvedValueOnce({ from: "key-old", to: "key-new" });

    const result = await run(() => rotateLedgerKeyAction(INITIAL, form()));

    expect(rotateMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER });
    expect(result).toEqual({ ok: true, message: "Signing key rotated: key-old retired, key-new now signs." });
    expect(revalidatePathMock).toHaveBeenCalledWith("/o/[slug]", "layout");
  });
});
