import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Enforcing the agent's spending limit from the console while the platform has payments switched off (payment safety
 * S2, S4): the library refuses before anything moves, and the action says so in the same words, never as a failure to
 * retry. The library is stood in for; tests/spending-limit-setup.test.ts covers it.
 */

const { authorizeMock, lib } = vi.hoisted(() => ({ authorizeMock: vi.fn(), lib: { enforceSpendingLimit: vi.fn(), turnOffSpendingLimit: vi.fn() } }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/circle/spending-limit-setup", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/circle/spending-limit-setup")>()), ...lib }));

import { enforceSpendingLimitAction } from "@/app/actions/agent";
import { PaymentsDisabledError } from "@/lib/payments-switch";

const access = { ok: true, user: { id: "user-1", email: null }, membership: { orgId: "org-1", slug: "testnet-2", name: "Testnet 2", mode: "live", role: "owner" } };
const form = () => {
  const data = new FormData();
  data.set("orgSlug", "testnet-2");
  return data;
};
const empty = { ok: false, message: "" };

beforeEach(() => {
  authorizeMock.mockReset();
  lib.enforceSpendingLimit.mockReset();
});

describe("enforceSpendingLimitAction while payments are switched off (payment safety S4)", () => {
  it("says payments are switched off, not that the setup should be tried again", async () => {
    authorizeMock.mockResolvedValue(access);
    lib.enforceSpendingLimit.mockRejectedValueOnce(new PaymentsDisabledError());

    expect(await enforceSpendingLimitAction(empty, form())).toEqual({ ok: false, message: "Payments are switched off for every workspace right now." });
  });
});
