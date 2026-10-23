import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Start the live slice from the report (docs/superpowers/specs/2026-10-18-live-slice-design.md L1, L6), with the
 * accountants the owner kept ticked brought along (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md
 * AC4): the result says who joined, and who to invite on the new workspace's Members.
 */

vi.mock("server-only", () => ({}));

const { authorizeMock, startMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), startMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/context", () => ({ currentConfig: () => ({ mainnetEnabled: true, mainnetAllowlist: ["*"] }) }));
vi.mock("@/lib/mainnet", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/mainnet")>()), mayUseMainnet: () => true }));
vi.mock("@/lib/live-slice", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/live-slice")>()), startLiveSlice: startMock }));

import { startLiveSliceAction } from "@/app/actions/live-slice";

const INITIAL = { ok: false, message: "" };

function form(vendorIds: string[], accountantIds: string[]): FormData {
  const data = new FormData();
  data.set("orgSlug", "acme-shadow");
  for (const id of vendorIds) data.append("vendorId", id);
  for (const id of accountantIds) data.append("accountantId", id);
  return data;
}

beforeEach(() => {
  authorizeMock.mockReset().mockResolvedValue({ ok: true, user: { id: "owner-1", email: "owner@acme.test" }, membership: { orgId: "org-1", role: "owner" } });
  startMock.mockReset().mockResolvedValue({ slug: "acme-live-slice", carried: [{ id: "v1" }], skipped: [], accountants: { added: ["books-1"], notAdded: [] } });
});

describe("startLiveSliceAction (accountant client links AC4)", () => {
  it("passes the accountants kept ticked, and says the accountant joined", async () => {
    const result = await startLiveSliceAction(INITIAL, form(["v1"], ["books-1"]));
    expect(startMock).toHaveBeenCalledWith({ userId: "owner-1", vendorIds: ["v1"], accountantIds: ["books-1"] });
    expect(result).toMatchObject({ ok: true, url: "/o/acme-live-slice/settings" });
    expect(result.message).toBe("Opened acme-live-slice on Arc mainnet with 1 vendor. Your accountant joined it. Next: take it live from its Settings.");
  });

  it("says who could not be brought along, and passes none when every box was unticked", async () => {
    startMock.mockResolvedValue({ slug: "acme-live-slice", carried: [{ id: "v1" }], skipped: [], accountants: { added: [], notAdded: ["books-1"] } });
    const result = await startLiveSliceAction(INITIAL, form(["v1"], []));
    expect(startMock).toHaveBeenCalledWith({ userId: "owner-1", vendorIds: ["v1"], accountantIds: [] });
    expect(result.message).toBe(
      "Opened acme-live-slice on Arc mainnet with 1 vendor. An accountant could not be brought along: invite them on its Members. Next: take it live from its Settings."
    );
  });
});
