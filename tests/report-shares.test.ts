import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import { listReportShares, REPORT_SHARE_LIMIT, ReportShareError, shareReport, stopSharingReport } from "@/lib/report-shares";
import { reportShareTokenHash } from "@/lib/report-share-token";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Sharing the workspace report by a public link (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S10,
 * S13): only the link's hash is stored, with its options; each share is a signed entry, and a link whose entry could not
 * be written is stopped at once; stopping revokes first and records it after; before migration 0095 runs, it says so.
 */

const { appendLedgerEntry, appendBestEffort, canSign } = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn(),
  appendBestEffort: vi.fn(async () => undefined),
  canSign: vi.fn(),
}));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry, assertLedgerCanSign: canSign }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: appendBestEffort }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b1";
const SHARE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005a1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const MISSING: FakeReply = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.report_shares' in the schema cache" } };
const OPTIONS = { names: "labels", amounts: "shown", title: "workspace" } as const;

type Row = Record<string, unknown>;
const row = (over: Row = {}): Row => ({
  id: SHARE,
  show_names: false,
  show_amounts: true,
  show_workspace_name: true,
  created_by: USER,
  created_at: "2026-10-10T08:00:00.000Z",
  revoked_at: null,
  revoked_by: null,
  ...over,
});

function database(start: { rows?: Row[]; missing?: boolean; patchError?: FakeReply } = {}) {
  let rows = [...(start.rows ?? [])];
  const fake = fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/report_shares") throw new Error(`unexpected request ${request.method} ${request.path}`);
    if (start.missing) return MISSING;
    const wantsObject = request.headers.get("accept")?.includes("application/vnd.pgrst.object+json") ?? false;
    if (request.method === "GET") {
      const live = request.params.get("revoked_at") === "is.null";
      const id = request.params.get("id")?.replace(/^eq\./, "");
      return { body: rows.filter((item) => (!live || item.revoked_at === null) && (!id || item.id === id)) };
    }
    if (request.method === "POST") {
      const made = row({ ...(request.body as Row), id: `share-${rows.length + 1}`, created_at: "2026-10-11T09:00:00.000Z" });
      rows.push(made);
      return { status: 201, body: wantsObject ? made : [made] };
    }
    if (request.method === "PATCH") {
      if (start.patchError) return start.patchError;
      const id = request.params.get("id")?.replace(/^eq\./, "");
      const changed = rows.filter((item) => item.id === id && (request.params.get("revoked_at") !== "is.null" || item.revoked_at === null));
      rows = rows.map((item) => (changed.includes(item) ? { ...item, ...(request.body as Row) } : item));
      return { body: changed.map((item) => ({ id: item.id })) };
    }
    throw new Error(`unexpected request ${request.method} ${request.path}`);
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
  return { fake, run, rows: () => rows };
}

const writes = (requests: RecordedRequest[], method: string) => requests.filter((request) => request.method === method);

beforeEach(() => {
  appendLedgerEntry.mockReset().mockResolvedValue({ seq: 9 });
  appendBestEffort.mockClear();
  canSign.mockReset();
});

describe("shareReport", () => {
  it("stores only the link's hash, with its options and who made it, then signs the share", async () => {
    const { fake, run } = database();
    const shared = await run(() => shareReport({ actorId: USER, options: OPTIONS }));
    expect(shared.token).toMatch(/^vxs_[A-Za-z0-9_-]{43}$/);
    const [insert] = writes(fake.requests, "POST");
    expect(insert.body).toEqual({
      org_id: ORG,
      token_hash: reportShareTokenHash(shared.token),
      show_names: false,
      show_amounts: true,
      show_workspace_name: true,
      created_by: USER,
    });
    expect(JSON.stringify(fake.requests.map((request) => request.body))).not.toContain(shared.token.slice(4));
    expect(appendLedgerEntry).toHaveBeenCalledWith({
      actor: "human",
      domain: "system",
      action: "report_shared",
      summary: "Shared the report by a public link: supplier labels, amounts shown, the workspace's name as its title",
      detail: { by: USER, shareId: shared.shareId, options: OPTIONS },
    });
    expect(canSign).toHaveBeenCalled();
  });

  it("says what each option shows in the entry's summary", async () => {
    const { run } = database();
    await run(() => shareReport({ actorId: USER, options: { names: "shown", amounts: "hidden", title: "neutral" } }));
    expect(appendLedgerEntry.mock.calls[0][0]).toMatchObject({
      summary: "Shared the report by a public link: supplier names, amounts hidden, a neutral title",
      detail: { options: { names: "shown", amounts: "hidden", title: "neutral" } },
    });
  });

  it("stops the link at once when its entry cannot be written, and asks to try again", async () => {
    appendLedgerEntry.mockRejectedValueOnce(new Error("ledger down"));
    const { fake, run, rows } = database();
    await expect(run(() => shareReport({ actorId: USER, options: OPTIONS }))).rejects.toMatchObject({ code: "not_recorded" });
    const [revoke] = writes(fake.requests, "PATCH");
    expect(revoke.body).toMatchObject({ revoked_by: USER, revoked_at: expect.any(String) });
    expect(rows()[0].revoked_at).not.toBeNull();
  });

  it("refuses before writing anything when the signing key cannot be read", async () => {
    canSign.mockImplementationOnce(() => {
      throw new Error("no key");
    });
    const { fake, run } = database();
    await expect(run(() => shareReport({ actorId: USER, options: OPTIONS }))).rejects.toThrow("no key");
    expect(writes(fake.requests, "POST")).toHaveLength(0);
  });

  it(`keeps at most ${REPORT_SHARE_LIMIT} links live at once`, async () => {
    const live = Array.from({ length: REPORT_SHARE_LIMIT }, (_, index) => row({ id: `live-${index}` }));
    const { fake, run } = database({ rows: [...live, row({ id: "old", revoked_at: "2026-10-09T00:00:00Z" })] });
    await expect(run(() => shareReport({ actorId: USER, options: OPTIONS }))).rejects.toMatchObject({
      code: "limit",
      message: "This workspace has 10 live links to its report. Stop sharing one before you make another.",
    });
    expect(writes(fake.requests, "POST")).toHaveLength(0);

    const { run: runWithRoom } = database({ rows: live.slice(1) });
    await expect(runWithRoom(() => shareReport({ actorId: USER, options: OPTIONS }))).resolves.toMatchObject({ shareId: expect.any(String) });
  });

  it("refuses options it does not know", async () => {
    const { fake, run } = database();
    await expect(run(() => shareReport({ actorId: USER, options: { ...OPTIONS, names: "everything" } as never }))).rejects.toMatchObject({ code: "options" });
    expect(fake.requests).toHaveLength(0);
  });

  it("says so before migration 0095 runs", async () => {
    const { run } = database({ missing: true });
    await expect(run(() => shareReport({ actorId: USER, options: OPTIONS }))).rejects.toMatchObject({
      code: "not_ready",
      message: "Sharing the report is not set up on this deployment yet.",
    });
    expect(appendLedgerEntry).not.toHaveBeenCalled();
  });
});

describe("stopSharingReport", () => {
  it("revokes the link first, then records who stopped it", async () => {
    const { fake, run, rows } = database({ rows: [row()] });
    await run(() => stopSharingReport({ actorId: USER, shareId: SHARE }));
    const [revoke] = writes(fake.requests, "PATCH");
    expect(revoke.params.get("id")).toBe(`eq.${SHARE}`);
    expect(revoke.params.get("revoked_at")).toBe("is.null");
    expect(revoke.body).toMatchObject({ revoked_by: USER, revoked_at: expect.any(String) });
    expect(rows()[0].revoked_at).not.toBeNull();
    expect(appendBestEffort).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "system",
      action: "report_unshared",
      summary: "Stopped sharing the report by a public link",
      detail: { by: USER, shareId: SHARE },
    });
  });

  it("refuses a link stopped already, or one not in this workspace", async () => {
    const { run } = database({ rows: [row({ revoked_at: "2026-10-10T09:00:00Z" })] });
    await expect(run(() => stopSharingReport({ actorId: USER, shareId: SHARE }))).rejects.toMatchObject({ code: "already_stopped" });
    const { run: runEmpty } = database();
    await expect(runEmpty(() => stopSharingReport({ actorId: USER, shareId: SHARE }))).rejects.toMatchObject({ code: "not_found" });
    expect(appendBestEffort).not.toHaveBeenCalled();
  });

  it("says a link stopped a moment before by someone else was stopped already", async () => {
    const { run } = database({ rows: [row()], patchError: { status: 400, body: { code: "P0001", message: "report_share_revoked: this shared report was stopped already" } } });
    await expect(run(() => stopSharingReport({ actorId: USER, shareId: SHARE }))).rejects.toMatchObject({ code: "already_stopped" });
  });

  it("says so before migration 0095 runs", async () => {
    const { run } = database({ missing: true });
    await expect(run(() => stopSharingReport({ actorId: USER, shareId: SHARE }))).rejects.toBeInstanceOf(ReportShareError);
  });
});

describe("listReportShares", () => {
  it("lists the live links, newest first, and counts the stopped ones", async () => {
    const { run } = database({
      rows: [
        row({ id: "a", created_at: "2026-10-09T08:00:00.000Z" }),
        row({ id: "b", created_at: "2026-10-10T08:00:00.000Z", show_names: true, show_amounts: false, show_workspace_name: false }),
        row({ id: "c", revoked_at: "2026-10-10T09:00:00.000Z", revoked_by: USER }),
      ],
    });
    const listed = await run(() => listReportShares(db()));
    expect(listed).toEqual({
      available: true,
      stopped: 1,
      live: [
        { id: "b", options: { names: "shown", amounts: "hidden", title: "neutral" }, createdBy: USER, createdAt: "2026-10-10T08:00:00.000Z" },
        { id: "a", options: OPTIONS, createdBy: USER, createdAt: "2026-10-09T08:00:00.000Z" },
      ],
    });
  });

  it("answers not available before migration 0095 runs", async () => {
    const { run } = database({ missing: true });
    await expect(run(() => listReportShares(db()))).resolves.toEqual({ available: false });
  });
});
