import { beforeEach, describe, expect, it, vi } from "vitest";
import { answerReportBaselineAction, shareReportAction, stopSharingReportAction } from "@/app/actions/report-share";
import { publicOrigin } from "@/lib/public-origin";

/**
 * The report page's actions (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S3, S9): each authorizes
 * first, with the permission its command needs, and runs the command inside the workspace's scope. The commands are
 * stood in for; tests/commands-report.test.ts covers them.
 */

const { authorizeMock, commands, revalidate } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  commands: { shareWorkspaceReport: vi.fn(), stopSharingWorkspaceReport: vi.fn(), answerReportBaseline: vi.fn() },
  revalidate: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: revalidate }));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: (_access: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/commands/report", () => commands);

const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const SHARE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000005e1";
const TOKEN = `vxs_${"A".repeat(43)}`;
const access = (role: "owner" | "admin") => ({ ok: true, user: { id: USER, email: null }, membership: { orgId: "org-1", slug: "harbor", name: "Harbor Books", mode: "live", role } });
const empty = { ok: false, message: "" };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  data.set("orgSlug", "harbor");
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
const OPTIONS = { names: "labels", amounts: "hidden", title: "neutral" };

beforeEach(() => {
  authorizeMock.mockReset();
  revalidate.mockReset();
  for (const command of Object.values(commands)) command.mockReset();
});

describe("shareReportAction", () => {
  it("shares with the options chosen, and gives the link once", async () => {
    authorizeMock.mockResolvedValue(access("admin"));
    commands.shareWorkspaceReport.mockResolvedValue({ ok: true, message: "Report shared. Copy the link now: it is shown only once.", token: TOKEN, shareId: SHARE });
    expect(await shareReportAction(empty, form(OPTIONS))).toEqual({
      ok: true,
      message: "Report shared. Copy the link now: it is shown only once.",
      url: `${publicOrigin()}/report/${TOKEN}`,
    });
    expect(authorizeMock).toHaveBeenCalledWith("harbor", "report.share");
    expect(commands.shareWorkspaceReport).toHaveBeenCalledWith(expect.objectContaining({ userId: USER, role: "admin", surface: { kind: "console" } }), {
      options: { names: "labels", amounts: "hidden", title: "neutral" },
    });
    expect(revalidate).toHaveBeenCalled();
  });

  it("refuses someone who may not share, and choices it cannot read, before the command runs", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "You do not have permission to do that." });
    expect(await shareReportAction(empty, form(OPTIONS))).toEqual({ ok: false, message: "You do not have permission to do that." });
    authorizeMock.mockResolvedValue(access("owner"));
    expect(await shareReportAction(empty, form({ ...OPTIONS, names: "everything" }))).toEqual({ ok: false, message: "Those choices could not be read. Choose each one again." });
    expect(commands.shareWorkspaceReport).not.toHaveBeenCalled();
  });

  it("gives no link when the command refuses, and refreshes the list when a link was made and stopped", async () => {
    authorizeMock.mockResolvedValue(access("owner"));
    commands.shareWorkspaceReport.mockResolvedValue({ ok: false, code: "not_recorded", message: "Recorded nothing.", changed: true });
    expect(await shareReportAction(empty, form(OPTIONS))).toEqual({ ok: false, message: "Recorded nothing." });
    expect(revalidate).toHaveBeenCalled();
  });
});

describe("stopSharingReportAction", () => {
  it("stops a link of this workspace's", async () => {
    authorizeMock.mockResolvedValue(access("owner"));
    commands.stopSharingWorkspaceReport.mockResolvedValue({ ok: true, message: "The link no longer opens the report." });
    expect(await stopSharingReportAction(empty, form({ shareId: SHARE }))).toEqual({ ok: true, message: "The link no longer opens the report." });
    expect(authorizeMock).toHaveBeenCalledWith("harbor", "report.share");
    expect(commands.stopSharingWorkspaceReport).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), { shareId: SHARE });
  });

  it("refuses an id that is not one before the command runs", async () => {
    authorizeMock.mockResolvedValue(access("owner"));
    expect(await stopSharingReportAction(empty, form({ shareId: "not-a-uuid" }))).toEqual({ ok: false, message: "That link is not one of this workspace's." });
    expect(commands.stopSharingWorkspaceReport).not.toHaveBeenCalled();
  });
});

describe("answerReportBaselineAction", () => {
  it("is an owner's, and passes the answer as typed", async () => {
    authorizeMock.mockResolvedValue(access("owner"));
    commands.answerReportBaseline.mockResolvedValue({ ok: true, message: "Saved your answer: 30 minutes a bill, 2 people." });
    expect(await answerReportBaselineAction(empty, form({ minutesPerBill: "30", peoplePerBill: "2" }))).toEqual({ ok: true, message: "Saved your answer: 30 minutes a bill, 2 people." });
    expect(authorizeMock).toHaveBeenCalledWith("harbor", "org.administer");
    expect(commands.answerReportBaseline).toHaveBeenCalledWith(expect.objectContaining({ userId: USER }), { minutesPerBill: "30", peoplePerBill: "2" });
  });

  it("refuses anyone who is not an owner before the command runs", async () => {
    authorizeMock.mockResolvedValue({ ok: false, message: "You do not have permission to do that." });
    expect(await answerReportBaselineAction(empty, form({ minutesPerBill: "30", peoplePerBill: "2" }))).toEqual({ ok: false, message: "You do not have permission to do that." });
    expect(commands.answerReportBaseline).not.toHaveBeenCalled();
  });
});
