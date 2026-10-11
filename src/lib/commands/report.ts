import { answerBaseline, BaselineError } from "../report-baseline";
import { ReportShareError, shareReport, stopSharingReport } from "../report-shares";
import type { ShareOptions } from "../shared-report";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Sharing the workspace report by a public link, stopping one, and answering how bills were handled before
 * (docs/superpowers/specs/2026-10-10-shared-report-design.md S3): owners and admins share and stop (`report.share`);
 * the answer is the business's own figure about itself, an owner's (`org.administer`). From the console only.
 */

export async function shareWorkspaceReport(actor: Actor, input: { options: ShareOptions }): Promise<CommandOutcome<{ token: string; shareId: string }>> {
  const refusal = gate(actor, "report.share");
  if (refusal) return refusal;
  try {
    const shared = await shareReport({ actorId: actor.userId, options: input.options });
    return done("Report shared. Copy the link now: it is shown only once.", shared);
  } catch (error) {
    // A link whose entry failed was made and stopped: the list of links changed.
    if (error instanceof ReportShareError) return refused(error.code, error.message, error.code === "not_recorded" ? { changed: true } : {});
    console.error("sharing the report failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function stopSharingWorkspaceReport(actor: Actor, input: { shareId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "report.unshare");
  if (refusal) return refusal;
  try {
    await stopSharingReport({ actorId: actor.userId, shareId: input.shareId });
    return done("The link no longer opens the report.");
  } catch (error) {
    if (error instanceof ReportShareError) return refused(error.code, error.message);
    console.error("stopping a shared report failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}

export async function answerReportBaseline(actor: Actor, input: { minutesPerBill: string; peoplePerBill: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "report.baseline");
  if (refusal) return refusal;
  try {
    const answer = await answerBaseline({ actorId: actor.userId, minutesPerBill: input.minutesPerBill, peoplePerBill: input.peoplePerBill });
    const minutes = `${answer.minutesPerBill.toLocaleString("en-US")} ${answer.minutesPerBill === 1 ? "minute" : "minutes"}`;
    const people = `${answer.peoplePerBill} ${answer.peoplePerBill === 1 ? "person" : "people"}`;
    return done(`Saved your answer: ${minutes} a bill, ${people}.`);
  } catch (error) {
    if (error instanceof BaselineError) return refused(error.code, error.message);
    console.error("answering the report's question failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
}
