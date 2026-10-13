import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Don't show again" and "Keep these limits" (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md
 * R1, R4): each checks the session's membership first, then records one mark for that person in that workspace's scope,
 * and only for the checklist the person's own role sees.
 */

vi.mock("server-only", () => ({}));

const { authorizeMock, recordMock, inOrgMock, revalidateMock, revalidatePathMock, waitingMock } = vi.hoisted(() => ({
  authorizeMock: vi.fn(),
  recordMock: vi.fn(async () => true),
  inOrgMock: vi.fn(async (_access: unknown, fn: () => Promise<unknown>) => fn()),
  revalidateMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  waitingMock: vi.fn(async () => false),
}));
vi.mock("@/lib/auth/authorize", () => ({ authorize: authorizeMock }));
vi.mock("@/lib/onboarding/read", () => ({ recordOnboardingMarks: recordMock, billWaitingOnApprovals: waitingMock }));
vi.mock("@/lib/dal/scope", () => ({ inOrg: inOrgMock }));
vi.mock("@/lib/auth/revalidate", () => ({ revalidateOrgPages: revalidateMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { confirmLimitsAction, dismissChecklistAction, recordAccountantVisitAction, recordApprovalsVisitAction } from "@/app/actions/onboarding";
import { ChecklistVisit } from "@/components/vx/ChecklistVisit";

const USER = { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1", email: "lena@ledgerline.example" };
const member = (role: string) => ({ ok: true, user: USER, membership: { orgId: "org-1", slug: "acme", name: "Acme", mode: "live", role, network: "arc-testnet" } });

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("dismissChecklistAction", () => {
  it.each([
    ["owner", "owner", "dismissed_owner"],
    ["admin", "owner", "dismissed_owner"],
    ["approver", "approver", "dismissed_approver"],
    ["accountant", "accountant", "dismissed_accountant"],
  ])("a %s dismisses the %s checklist for good, as themselves, in the workspace's scope", async (role, checklist, mark) => {
    authorizeMock.mockResolvedValueOnce(member(role));
    await dismissChecklistAction(form({ orgSlug: "acme", role: checklist }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "workspace.read");
    expect(inOrgMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(USER.id, [mark]);
    expect(revalidateMock).toHaveBeenCalled();
  });

  it("records nothing for another role's checklist, a viewer's, or one that is not a checklist", async () => {
    for (const [role, checklist] of [
      ["approver", "owner"],
      ["owner", "accountant"],
      ["viewer", "owner"],
      ["owner", "anything"],
    ]) {
      authorizeMock.mockResolvedValueOnce(member(role));
      await dismissChecklistAction(form({ orgSlug: "acme", role: checklist }));
    }
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records nothing for someone the session does not make a member", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });
    await dismissChecklistAction(form({ orgSlug: "acme", role: "owner" }));
    expect(inOrgMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("confirmLimitsAction", () => {
  it("records the limits kept, for whoever may change them", async () => {
    authorizeMock.mockResolvedValueOnce(member("admin"));
    await confirmLimitsAction(form({ orgSlug: "acme" }));
    expect(authorizeMock).toHaveBeenCalledWith("acme", "agent.budget");
    expect(recordMock).toHaveBeenCalledWith(USER.id, ["limits_confirmed"]);
  });

  it("records nothing when the role may not change the limits", async () => {
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "Your role in this workspace (approver) cannot do that." });
    await confirmLimitsAction(form({ orgSlug: "acme" }));
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("recordApprovalsVisitAction: Approvals opened, recorded from the browser, never while the page renders", () => {
  it("records Approvals opened for an approver, as themselves, in the workspace's scope", async () => {
    authorizeMock.mockResolvedValueOnce(member("approver"));
    await recordApprovalsVisitAction("acme");
    expect(authorizeMock).toHaveBeenCalledWith("acme", "workspace.read");
    expect(inOrgMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(USER.id, ["approvals_opened"]);
  });

  it("records a held bill's reasons seen only when the server reads a bill waiting there", async () => {
    authorizeMock.mockResolvedValueOnce(member("approver"));
    waitingMock.mockResolvedValueOnce(true);
    await recordApprovalsVisitAction("acme");
    expect(recordMock).toHaveBeenCalledWith(USER.id, ["approvals_opened", "held_reason_seen"]);
  });

  it("records nothing for any other role, or for someone the session does not make a member", async () => {
    for (const role of ["owner", "admin", "accountant", "viewer"]) {
      authorizeMock.mockResolvedValueOnce(member(role));
      await recordApprovalsVisitAction("acme");
    }
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });
    await recordApprovalsVisitAction("other-workspace");
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("recordAccountantVisitAction: the accountant console opened, recorded from the browser", () => {
  it("records the console opened for an accountant, as themselves, in that workspace's scope", async () => {
    authorizeMock.mockResolvedValueOnce(member("accountant"));
    await recordAccountantVisitAction("acme", null);
    expect(authorizeMock).toHaveBeenCalledWith("acme", "workspace.read");
    expect(inOrgMock).toHaveBeenCalledTimes(1);
    expect(recordMock).toHaveBeenCalledWith(USER.id, ["accountant_console_opened"]);
  });

  it("records the queue opened only in the workspace the console is narrowed to", async () => {
    authorizeMock.mockResolvedValueOnce(member("accountant"));
    await recordAccountantVisitAction("acme", "acme");
    expect(recordMock).toHaveBeenLastCalledWith(USER.id, ["accountant_console_opened", "accountant_queue_opened"]);
    authorizeMock.mockResolvedValueOnce(member("accountant"));
    await recordAccountantVisitAction("acme", "lumen-studio");
    expect(recordMock).toHaveBeenLastCalledWith(USER.id, ["accountant_console_opened"]);
    authorizeMock.mockResolvedValueOnce(member("accountant"));
    await recordAccountantVisitAction("acme", { slug: "acme" });
    expect(recordMock).toHaveBeenLastCalledWith(USER.id, ["accountant_console_opened"]);
  });

  it("records nothing for any other role, or for someone the session does not make a member", async () => {
    for (const role of ["owner", "admin", "approver", "viewer"]) {
      authorizeMock.mockResolvedValueOnce(member(role));
      await recordAccountantVisitAction("acme", "acme");
    }
    authorizeMock.mockResolvedValueOnce({ ok: false, message: "You are not a member of this workspace." });
    await recordAccountantVisitAction("other-workspace", "other-workspace");
    expect(recordMock).not.toHaveBeenCalled();
  });
});

describe("no page writes a mark while it renders (Next.js: no mutation as a side effect of rendering)", () => {
  it("renders the visit's recorder as nothing on the server, and sends nothing from there", () => {
    expect(renderToStaticMarkup(<ChecklistVisit page="approvals" slugs={["acme"]} />)).toBe("");
    expect(renderToStaticMarkup(<ChecklistVisit page="accountant" slugs={["acme", "lumen-studio"]} queue="acme" />)).toBe("");
    expect(authorizeMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it("records marks from Server Actions only: no page or layout calls the recording function", () => {
    const app = path.join(process.cwd(), "src", "app");
    const rendered = (readdirSync(app, { recursive: true }) as string[]).filter((file) => ["page.tsx", "layout.tsx"].includes(path.basename(file)));
    expect(rendered.length).toBeGreaterThan(10);
    for (const file of rendered) {
      const source = readFileSync(path.join(app, file), "utf8");
      expect(source, file).not.toMatch(/\brecordOnboardingMarks\(/);
    }
    // The accountant console's read writes nothing either: its recording is the action's.
    const accountant = readFileSync(path.join(process.cwd(), "src", "lib", "onboarding", "accountant.ts"), "utf8");
    const read = accountant.slice(accountant.indexOf("export async function readAccountantOnboarding"));
    expect(read).not.toMatch(/\brecordOnboardingMarks\(/);
  });
});
