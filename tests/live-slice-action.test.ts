import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Start the live slice from the report (docs/superpowers/specs/2026-10-18-live-slice-design.md L1, L6), with the
 * accountants the owner kept ticked brought along (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md
 * AC4): the result says who joined, and names who to invite on the new workspace's Members.
 */

vi.mock("server-only", () => ({}));

const { authorizeMock, startMock, listMembersMock } = vi.hoisted(() => ({ authorizeMock: vi.fn(), startMock: vi.fn(), listMembersMock: vi.fn() }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: vi.fn() }));
vi.mock("@/lib/context", () => ({ currentConfig: () => ({ mainnetEnabled: true, mainnetAllowlist: ["*"] }) }));
vi.mock("@/lib/mainnet", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/mainnet")>()), mayUseMainnet: () => true }));
vi.mock("@/lib/live-slice", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/live-slice")>()), startLiveSlice: startMock }));
vi.mock("@/lib/platform/members", () => ({ listMembers: listMembersMock }));

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
  listMembersMock.mockReset().mockResolvedValue([
    { userId: "owner-1", email: "owner@acme.test", role: "owner", joinedAt: "2026-10-01T00:00:00Z" },
    { userId: "books-1", email: "books@practice.example", role: "accountant", joinedAt: "2026-10-02T00:00:00Z" },
    { userId: "books-2", email: "ledger@practice.example", role: "viewer", joinedAt: "2026-10-03T00:00:00Z" },
  ]);
});

describe("startLiveSliceAction (accountant client links AC4)", () => {
  it("passes the accountants kept ticked, and says the accountant joined", async () => {
    const result = await startLiveSliceAction(INITIAL, form(["v1"], ["books-1"]));
    expect(startMock).toHaveBeenCalledWith({ userId: "owner-1", vendorIds: ["v1"], accountantIds: ["books-1"] });
    expect(result).toMatchObject({ ok: true, url: "/o/acme-live-slice/settings" });
    expect(result.message).toBe("Opened acme-live-slice on Arc mainnet with 1 vendor. Your accountant joined it. Next: take it live from its Settings.");
    // Every accountant joined: there is no one to name, so the members are not read.
    expect(listMembersMock).not.toHaveBeenCalled();
  });

  it("names who could not be brought along by their email, and passes none when every box was unticked", async () => {
    startMock.mockResolvedValue({ slug: "acme-live-slice", carried: [{ id: "v1" }], skipped: [], accountants: { added: [], notAdded: ["books-1"] } });
    const result = await startLiveSliceAction(INITIAL, form(["v1"], []));
    expect(startMock).toHaveBeenCalledWith({ userId: "owner-1", vendorIds: ["v1"], accountantIds: [] });
    expect(listMembersMock).toHaveBeenCalledWith("org-1");
    expect(result.message).toBe(
      "Opened acme-live-slice on Arc mainnet with 1 vendor. books@practice.example could not be brought along: invite them on its Members. Next: take it live from its Settings."
    );
  });

  it("names each one refused, even one demoted since the page loaded, and counts one no longer a member", async () => {
    startMock.mockResolvedValue({ slug: "acme-live-slice", carried: [{ id: "v1" }], skipped: [], accountants: { added: ["books-3"], notAdded: ["books-1", "books-2", "gone-1"] } });
    const result = await startLiveSliceAction(INITIAL, form(["v1"], ["books-1", "books-2", "books-3", "gone-1"]));
    expect(result.message).toBe(
      "Opened acme-live-slice on Arc mainnet with 1 vendor. Your accountant joined it. books@practice.example, ledger@practice.example and another accountant could not be brought along: invite them on its Members. Next: take it live from its Settings."
    );
  });

  it("counts them when the members cannot be read, and still answers that the slice opened", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    listMembersMock.mockRejectedValue(new Error("down"));
    startMock.mockResolvedValue({ slug: "acme-live-slice", carried: [{ id: "v1" }], skipped: [], accountants: { added: [], notAdded: ["books-1", "books-2"] } });
    const result = await startLiveSliceAction(INITIAL, form(["v1"], ["books-1", "books-2"]));
    expect(result).toMatchObject({ ok: true, url: "/o/acme-live-slice/settings" });
    expect(result.message).toBe(
      "Opened acme-live-slice on Arc mainnet with 1 vendor. 2 accountants could not be brought along: invite them on its Members. Next: take it live from its Settings."
    );
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
