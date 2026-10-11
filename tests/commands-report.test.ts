import { beforeEach, describe, expect, it, vi } from "vitest";
import { can } from "@/lib/auth/roles";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { answerReportBaseline, shareWorkspaceReport, stopSharingWorkspaceReport } from "@/lib/commands/report";
import { BaselineError } from "@/lib/report-baseline";
import { ReportShareError } from "@/lib/report-shares";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Sharing the report, stopping a link and answering the value question as commands (docs/superpowers/specs/
 * 2026-10-10-shared-report-design.md S3): owners and admins share and stop (`report.share`), as they manage API keys
 * and webhooks; only an owner answers (`org.administer`); from the console only. The gate runs before anything is read.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { shareReport: vi.fn(), stopSharingReport: vi.fn(), answerBaseline: vi.fn() } }));
vi.mock("@/lib/report-shares", async (original) => ({
  ...(await original<typeof import("@/lib/report-shares")>()),
  shareReport: mocks.shareReport,
  stopSharingReport: mocks.stopSharingReport,
}));
vi.mock("@/lib/report-baseline", async (original) => ({ ...(await original<typeof import("@/lib/report-baseline")>()), answerBaseline: mocks.answerBaseline }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d1";
const SHARE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005d1";
const OPTIONS = { names: "labels", amounts: "shown", title: "workspace" } as const;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("who may share the report and answer for it", () => {
  it("is owners and admins to share or stop, an owner to answer, from the console only", () => {
    expect(COMMAND_PERMISSIONS["report.share"]).toBe("report.share");
    expect(COMMAND_PERMISSIONS["report.unshare"]).toBe("report.share");
    expect(COMMAND_PERMISSIONS["report.baseline"]).toBe("org.administer");
    expect((["owner", "admin", "approver", "viewer"] as const).filter((role) => can(role, "report.share"))).toEqual(["owner", "admin"]);
    for (const surface of ["api", "slack", "telegram", "github"] as const) {
      for (const command of ["report.share", "report.unshare", "report.baseline"] as const) expect(SURFACE_COMMANDS[surface]).not.toContain(command);
    }
  });

  it.each(["owner", "admin"] as const)("lets an %s share and stop", async (role) => {
    mocks.shareReport.mockResolvedValueOnce({ token: "vxs_t", shareId: SHARE });
    expect(await run(() => shareWorkspaceReport(actor({ role }), { options: OPTIONS }))).toEqual({
      ok: true,
      message: "Report shared. Copy the link now: it is shown only once.",
      token: "vxs_t",
      shareId: SHARE,
    });
    expect(mocks.shareReport).toHaveBeenCalledWith({ actorId: USER, options: OPTIONS });
    mocks.stopSharingReport.mockResolvedValueOnce(undefined);
    expect(await run(() => stopSharingWorkspaceReport(actor({ role }), { shareId: SHARE }))).toEqual({ ok: true, message: "The link no longer opens the report." });
    expect(mocks.stopSharingReport).toHaveBeenCalledWith({ actorId: USER, shareId: SHARE });
  });

  it.each(["approver", "viewer"] as const)("refuses an %s before anything is read", async (role) => {
    expect(await run(() => shareWorkspaceReport(actor({ role }), { options: OPTIONS }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => stopSharingWorkspaceReport(actor({ role }), { shareId: SHARE }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => answerReportBaseline(actor({ role }), { minutesPerBill: "20", peoplePerBill: "2" }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.shareReport).not.toHaveBeenCalled();
    expect(mocks.stopSharingReport).not.toHaveBeenCalled();
    expect(mocks.answerBaseline).not.toHaveBeenCalled();
  });

  it("lets only an owner answer", async () => {
    expect(await run(() => answerReportBaseline(actor({ role: "admin" }), { minutesPerBill: "20", peoplePerBill: "2" }))).toMatchObject({ ok: false, code: "forbidden" });
    mocks.answerBaseline.mockResolvedValueOnce({ id: "b-1", minutesPerBill: 1500, peoplePerBill: 1, answeredBy: USER, answeredAt: "2026-10-11T09:00:00Z" });
    expect(await run(() => answerReportBaseline(actor(), { minutesPerBill: "1,500", peoplePerBill: "1" }))).toEqual({
      ok: true,
      message: "Saved your answer: 1,500 minutes a bill, 1 person.",
    });
    expect(mocks.answerBaseline).toHaveBeenCalledWith({ actorId: USER, minutesPerBill: "1,500", peoplePerBill: "1" });
  });

  it("refuses a surface other than the console", async () => {
    expect(await run(() => shareWorkspaceReport(actor({ surface: { kind: "api", apiKeyId: "k-1" } }), { options: OPTIONS }))).toMatchObject({ ok: false, code: "surface" });
  });
});

describe("refusals", () => {
  it("say a domain refusal in its own words, and anything else as a try-again", async () => {
    mocks.shareReport.mockRejectedValueOnce(new ReportShareError("not_ready"));
    expect(await run(() => shareWorkspaceReport(actor(), { options: OPTIONS }))).toEqual({
      ok: false,
      code: "not_ready",
      message: "Sharing the report is not set up on this deployment yet.",
    });
    mocks.shareReport.mockRejectedValueOnce(new ReportShareError("not_recorded"));
    expect(await run(() => shareWorkspaceReport(actor(), { options: OPTIONS }))).toMatchObject({ ok: false, code: "not_recorded", changed: true });
    mocks.stopSharingReport.mockRejectedValueOnce(new ReportShareError("already_stopped"));
    expect(await run(() => stopSharingWorkspaceReport(actor(), { shareId: SHARE }))).toEqual({ ok: false, code: "already_stopped", message: "That link was stopped already." });
    mocks.answerBaseline.mockRejectedValueOnce(new BaselineError("minutes"));
    expect(await run(() => answerReportBaseline(actor(), { minutesPerBill: "0", peoplePerBill: "1" }))).toMatchObject({ ok: false, code: "minutes" });
    mocks.shareReport.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await run(() => shareWorkspaceReport(actor(), { options: OPTIONS }))).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
  });
});
