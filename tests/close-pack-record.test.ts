import { afterEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

const { appendEntryMock } = vi.hoisted(() => ({ appendEntryMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ledger")>()),
  appendLedgerEntry: appendEntryMock,
}));

import { CLOSE_PACK_EXPORT_LIMIT, recentClosePackExportsBy, recordClosePackExport } from "@/lib/close-pack/record";
import { closePackMonth } from "@/lib/close-pack/month";
import { takeClosePackDownloadToken, takeClosePackPageToken } from "@/lib/rate-limit";
import { samplePack } from "./support/close-pack-fixtures";

/**
 * Each close pack download is recorded (docs/superpowers/specs/2026-10-25-monthly-close-pack-design.md CP13, CP15): one
 * `close_pack_exported` entry that names the person by id, the month, the format, the counts, the file's SHA-256 and the
 * ledger's head, appended best effort; the brake counts those entries; and the page's own bucket (CP11).
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const SHA = "ab".repeat(32);

function scope(rows: number) {
  const fake = fakeSupabase(() => ({ body: Array.from({ length: rows }, (_, index) => ({ id: `e-${index}` })) }));
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run };
}

afterEach(() => {
  appendEntryMock.mockReset();
  vi.restoreAllMocks();
});

describe("recordClosePackExport (close pack CP13)", () => {
  it("appends close_pack_exported with who, the month, the format, the counts, the file's hash and the head", async () => {
    const { run } = scope(0);
    const pack = samplePack();
    await run(() => recordClosePackExport({ orgId: ORG, userId: USER, pack, format: "csv", sha256: SHA }));
    expect(appendEntryMock).toHaveBeenCalledTimes(1);
    expect(appendEntryMock.mock.calls[0][0]).toEqual({
      actor: "human",
      domain: "system",
      action: "close_pack_exported",
      summary: "Close pack for October 2026 downloaded as CSV: 3 payments settled, 1 not settled",
      detail: { by: USER, month: "2026-10", ended: true, format: "csv", payments: 3, notSettled: 1, sha256: SHA, headSeq: 99 },
    });
    expect(JSON.stringify(appendEntryMock.mock.calls[0][0])).not.toContain("@");
  });

  it("says so far for a month not ended, and words one payment", async () => {
    const { run } = scope(0);
    const now = new Date("2026-10-25T00:00:00Z");
    const pack = samplePack({ now, month: closePackMonth("2026-10", now)! });
    const one = { ...pack, rows: pack.rows.slice(0, 1), notSettled: [] };
    await run(() => recordClosePackExport({ orgId: ORG, userId: USER, pack: one, format: "json", sha256: SHA }));
    expect(appendEntryMock.mock.calls[0][0]).toMatchObject({
      summary: "Close pack for October 2026 so far downloaded as JSON: 1 payment settled, 0 not settled",
      detail: { ended: false, format: "json", payments: 1, notSettled: 0 },
    });
  });

  it("is best effort: a refused append is logged and does not throw", async () => {
    const { run } = scope(0);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    appendEntryMock.mockRejectedValueOnce(new Error("no signing key"));
    await expect(run(() => recordClosePackExport({ orgId: ORG, userId: USER, pack: samplePack(), format: "csv", sha256: SHA }))).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalledWith("ledger entry not recorded", "close_pack_exported", ORG);
  });
});

describe("recentClosePackExportsBy (close pack CP15)", () => {
  it("counts this person's close_pack_exported entries in the last ten minutes, from the ledger, capped at the limit", async () => {
    const { fake, run } = scope(4);
    const now = new Date("2026-10-25T10:00:00.000Z");
    expect(await run(() => recentClosePackExportsBy(USER, now))).toBe(4);
    const [read] = fake.requests.filter((request: RecordedRequest) => request.path === "/rest/v1/ledger_entries");
    expect(read.params.get("action")).toBe("eq.close_pack_exported");
    expect(read.params.get("ts")).toBe("gt.2026-10-25T09:50:00.000Z");
    expect(read.params.get("detail->>by")).toBe(`eq.${USER}`);
    expect(read.params.get("limit")).toBe("10");
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(CLOSE_PACK_EXPORT_LIMIT).toEqual({ count: 10, windowMs: 600_000 });
  });
});

describe("takeClosePackPageToken (close pack CP11)", () => {
  it("lets a member read the page ten times at once, then once every 6 seconds", () => {
    const member = `member-${Date.now()}`;
    const start = 1_000_000;
    for (let read = 0; read < 10; read += 1) expect(takeClosePackPageToken(member, start)).toBe(true);
    expect(takeClosePackPageToken(member, start)).toBe(false);
    expect(takeClosePackPageToken(member, start + 5_999)).toBe(false);
    expect(takeClosePackPageToken(member, start + 6_000)).toBe(true);
    expect(takeClosePackPageToken(member, start + 6_000)).toBe(false);
  });

  it("keeps each member's reads apart", () => {
    const start = 2_000_000;
    for (let read = 0; read < 10; read += 1) takeClosePackPageToken("member-a", start);
    expect(takeClosePackPageToken("member-a", start)).toBe(false);
    expect(takeClosePackPageToken("member-b", start)).toBe(true);
  });
});

describe("takeClosePackDownloadToken (close pack CP15)", () => {
  // The route keys it by person and workspace (`<userId>:<orgId>`), as the ledger's ten in ten minutes counts.
  it("serves six downloads within a minute, in any tab, then one a minute", () => {
    const key = `downloader-${Date.now()}:org-a`;
    const start = 3_000_000;
    for (let download = 0; download < 6; download += 1) expect(takeClosePackDownloadToken(key, start)).toBe(true);
    expect(takeClosePackDownloadToken(key, start)).toBe(false);
    expect(takeClosePackDownloadToken(key, start + 59_999)).toBe(false);
    expect(takeClosePackDownloadToken(key, start + 60_000)).toBe(true);
    expect(takeClosePackDownloadToken(key, start + 60_000)).toBe(false);
  });

  it("counts downloads made one after another as it counts those started together: six, then the next waits", () => {
    // CSV then JSON for three months, one every 5 seconds, each after the last has finished.
    const key = `one-after-another-${Date.now()}:org-a`;
    const start = 5_000_000;
    for (let second = 0; second <= 25; second += 5) expect(takeClosePackDownloadToken(key, start + second * 1_000), `+${second}s`).toBe(true);
    for (let second = 30; second <= 55; second += 5) expect(takeClosePackDownloadToken(key, start + second * 1_000), `+${second}s`).toBe(false);
    expect(takeClosePackDownloadToken(key, start + 65_000)).toBe(true);
    expect(takeClosePackDownloadToken(key, start + 70_000)).toBe(false);
  });

  it("keeps each person's downloads in each workspace apart, and apart from the page's reads", () => {
    const start = 4_000_000;
    for (let download = 0; download < 6; download += 1) takeClosePackDownloadToken("downloader-a:org-a", start);
    expect(takeClosePackDownloadToken("downloader-a:org-a", start)).toBe(false);
    expect(takeClosePackDownloadToken("downloader-a:org-b", start)).toBe(true);
    expect(takeClosePackDownloadToken("downloader-b:org-a", start)).toBe(true);
    expect(takeClosePackPageToken("downloader-a", start)).toBe(true);
  });
});
