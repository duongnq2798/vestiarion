"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { consoleActor } from "@/lib/commands/actor";
import { answerReportBaseline, shareWorkspaceReport, stopSharingWorkspaceReport } from "@/lib/commands/report";
import { inOrg } from "@/lib/dal/scope";
import { publicOrigin } from "@/lib/public-origin";

/**
 * The report's share link and value question, from the report page (docs/superpowers/specs/2026-10-10-shared-report-
 * design.md S2, S3, S9): an owner or admin makes or stops a public link (`report.share`); an owner answers how long a
 * bill took before (`org.administer`). Through the commands, inside the workspace's scope.
 */

export interface ReportShareActionResult {
  ok: boolean;
  message: string;
  /** The new link, given once, when it is made. */
  url?: string;
}

const optionsSchema = z.object({
  names: z.enum(["labels", "shown"]),
  amounts: z.enum(["shown", "hidden"]),
  title: z.enum(["workspace", "neutral"]),
});
const NOT_READ = "Those choices could not be read. Choose each one again.";

export async function shareReportAction(_previous: ReportShareActionResult, formData: FormData): Promise<ReportShareActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "report.share");
  if (!auth.ok) return { ok: false, message: auth.message };
  const options = optionsSchema.safeParse({ names: formData.get("names"), amounts: formData.get("amounts"), title: formData.get("title") });
  if (!options.success) return { ok: false, message: NOT_READ };
  return inOrg(auth, async () => {
    const outcome = await shareWorkspaceReport(consoleActor(auth), { options: options.data });
    if (outcome.ok || outcome.changed) revalidateOrgPages();
    if (!outcome.ok) return { ok: false, message: outcome.message };
    return { ok: true, message: outcome.message, url: `${publicOrigin()}/report/${outcome.token}` };
  });
}

export async function stopSharingReportAction(_previous: ReportShareActionResult, formData: FormData): Promise<ReportShareActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "report.share");
  if (!auth.ok) return { ok: false, message: auth.message };
  const shareId = z.string().uuid().safeParse(formData.get("shareId"));
  if (!shareId.success) return { ok: false, message: "That link is not one of this workspace's." };
  return inOrg(auth, async () => consoleAnswer(await stopSharingWorkspaceReport(consoleActor(auth), { shareId: shareId.data })));
}

export async function answerReportBaselineAction(_previous: ReportShareActionResult, formData: FormData): Promise<ReportShareActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  const minutesPerBill = String(formData.get("minutesPerBill") ?? "").slice(0, 20);
  const peoplePerBill = String(formData.get("peoplePerBill") ?? "").slice(0, 20);
  return inOrg(auth, async () => consoleAnswer(await answerReportBaseline(consoleActor(auth), { minutesPerBill, peoplePerBill })));
}
