import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Confirm this track record (docs/superpowers/specs/2026-11-07-track-record-design.md TR4, TR5): an accountant's alone,
 * against the SHA-256 the page showed, once per person per record, and signed or said to have failed.
 */

const { authorizeMock, readMock, confirmMock, revalidateMock, tokenMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  readMock: vi.fn(),
  confirmMock: vi.fn(),
  revalidateMock: vi.fn(),
  tokenMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: revalidateMock }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/track-record/read", () => ({ readTrackRecord: readMock }));
vi.mock("@/lib/track-record/record", () => ({ recordTrackRecordConfirmation: confirmMock }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rate-limit")>()), takeTrackRecordDownloadToken: tokenMock }));

import { confirmTrackRecordAction } from "@/app/actions/track-record";
import { TRACK_RECORD_CHANGED } from "@/lib/track-record/build";

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const SHA = "c".repeat(64);
const RECORD = { contentSha256: SHA, totals: { given: 6, agreed: 5, disagreed: 1 }, confirmations: [] as unknown[] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  authorizeMock.mockResolvedValue({ ok: true, user: { id: USER, email: null }, membership: { orgId: "org-1", slug: "acme-shadow", name: "Acme Shadow", mode: "live", role: "accountant" } });
  readMock.mockResolvedValue(RECORD);
  confirmMock.mockResolvedValue({ seq: 812 });
  tokenMock.mockReturnValue(true);
});

describe("confirmTrackRecordAction", () => {
  it("asks for track_record.confirm before anything is read (TR4)", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (owner) cannot do that." });
    expect(await confirmTrackRecordAction("acme-shadow", SHA)).toEqual({ ok: false, message: "Your role in this workspace (owner) cannot do that." });
    expect(authorizeMock).toHaveBeenCalledWith("acme-shadow", "track_record.confirm");
    expect(readMock).not.toHaveBeenCalled();
  });

  it("signs the record the page showed, and reads the page again (TR5)", async () => {
    expect(await confirmTrackRecordAction("acme-shadow", SHA)).toEqual({ ok: true, message: "Confirmed. Your confirmation is signed in the ledger.", seq: 812 });
    expect(readMock).toHaveBeenCalledWith({ workspace: { slug: "acme-shadow", name: "Acme Shadow" }, sandbox: false, people: "id" });
    expect(confirmMock).toHaveBeenCalledWith({ userId: USER, role: "accountant", record: RECORD });
    expect(revalidateMock).toHaveBeenCalled();
  });

  it("signs nothing when the record changed since the page showed it, or the hash is not one", async () => {
    expect(await confirmTrackRecordAction("acme-shadow", "d".repeat(64))).toEqual({ ok: false, message: TRACK_RECORD_CHANGED });
    expect(await confirmTrackRecordAction("acme-shadow", "not a hash")).toEqual({ ok: false, message: TRACK_RECORD_CHANGED });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("signs nothing twice: a person who confirmed this record is told when", async () => {
    readMock.mockResolvedValueOnce({ ...RECORD, confirmations: [{ seq: 700, at: "2026-11-07T10:00:00.000Z", by: USER, who: null, sha256: SHA, current: true }] });
    expect(await confirmTrackRecordAction("acme-shadow", SHA)).toEqual({ ok: true, message: "You confirmed this track record on Nov 7, 2026." });
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("signs nothing with no verdict on a real bill", async () => {
    readMock.mockResolvedValueOnce({ ...RECORD, totals: { given: 0, agreed: 0, disagreed: 0 } });
    expect((await confirmTrackRecordAction("acme-shadow", SHA)).ok).toBe(false);
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("says plainly that a confirmation that could not be signed was not given", async () => {
    confirmMock.mockRejectedValueOnce(new Error("ledger down"));
    expect(await confirmTrackRecordAction("acme-shadow", SHA)).toEqual({ ok: false, message: "The track record was not confirmed. Try again in a moment." });
    expect(revalidateMock).not.toHaveBeenCalled();
  });

  it("refuses a burst before anything is read", async () => {
    tokenMock.mockReturnValueOnce(false);
    expect((await confirmTrackRecordAction("acme-shadow", SHA)).ok).toBe(false);
    expect(readMock).not.toHaveBeenCalled();
  });
});
