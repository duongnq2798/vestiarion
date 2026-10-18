import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import ReportBaselineControl from "@/components/ReportBaselineControl";
import { ReportShareButton, ReportShareLinks } from "@/components/ReportShareControl";
import { ActualsComparison } from "@/components/vx/ActualsComparison";
import { CurrencyReport } from "@/components/vx/CurrencyReport";
import { ReportValue } from "@/components/vx/ReportValue";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { WorkspaceReport } from "@/components/vx/WorkspaceReport";
import { sectionTitle } from "@/components/vx/nav";
import { readActualsFacts } from "@/lib/actual-payments";
import { orgHref } from "@/lib/auth/org-paths";
import { readCurrencyReport } from "@/lib/currency-report-read";
import { compareActuals } from "@/lib/actual-payments-compare";
import { actualsCsvTemplate } from "@/lib/actual-payments-csv";
import { viewerCan } from "@/lib/auth/authorize";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { readStatementSetup } from "@/lib/bank-statements";
import { simulatesPayments } from "@/lib/capability-read";
import { shellModes } from "@/lib/circle";
import { db } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import { listMembers } from "@/lib/platform/members";
import { stats } from "@/lib/queries";
import { readBaseline } from "@/lib/report-baseline";
import { listReportShares } from "@/lib/report-shares";
import { paidOutside, reportValue } from "@/lib/report-value";
import { shareOptionWords } from "@/lib/shared-report";
import { workspaceNetwork } from "@/lib/workspace-network";
import { buildReport } from "@/lib/workspace-report";
import { LiveSliceStart } from "@/components/vx/LiveSliceStart";
import { utcDay } from "@/lib/copy";
import { readLiveSlice, sliceVendors } from "@/lib/live-slice";
import { readReportFacts } from "@/lib/workspace-report-read";
import { shellStatus } from "@/lib/shell-status";

export const dynamic = "force-dynamic";

/**
 * A CSV or a bank statement's ticked lines, up to 200 payments, are saved here one at a time, each with its signed entry:
 * the page's actions may take a while.
 */
export const maxDuration = 300;

export const metadata: Metadata = { title: sectionTitle("report") };

/**
 * The workspace report (docs/superpowers/specs/2026-10-09-workspace-report-design.md R1): every member reads what the
 * agent did with the workspace's real bills, and, bill by bill, what the business recorded paying beside it
 * (docs/superpowers/specs/2026-10-10-actual-payments-design.md). A read that fails throws to the section's error state
 * (R7): a report with rows missing would understate what happened. Before migration 0090 runs, the comparison says so
 * and the rest of the report is unchanged; before 0094, so does its bank statement card
 * (docs/superpowers/specs/2026-10-10-bank-statement-design.md B11, B12).
 *
 * Its value section keeps measured, estimated and not-counted figures apart, and an owner answers the question the
 * estimate rests on; an owner or admin shares the report by a public link, and every member sees the live links
 * (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S3, S8). Before migration 0095 runs, the value section
 * shows its measured figures and says the answer is not set up, and sharing says it is not set up.
 */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ actuals?: string | string[] }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const query = await searchParams;
    const [facts, actuals, dashboardStats, canRecord, shares, baseline] = await Promise.all([
      // Simulated as the workspace's capability says, not its mode: a sandbox connected to Circle pays for real (capability
      // and reasons R5).
      readReportFacts(db(), workspaceNetwork().id, { sandbox: simulatesPayments(access.membership.mode) }),
      readActualsFacts(db()),
      stats(),
      viewerCan(slug, "records.write"),
      listReportShares(db()),
      readBaseline(db()),
    ]);
    const canShare = can(access.membership.role, "report.share");
    const canAnswer = can(access.membership.role, "org.administer");
    const report = buildReport(facts);
    // In shadow mode, the live slice opened from here, or the vendors one would carry (live slice L1, L5). Best effort:
    // a read that fails shows the steps alone.
    const sliceRead = report.readiness
      ? await Promise.all([readLiveSlice(db()), sliceVendors(db())]).catch((error: unknown) => {
          console.error("report: live slice not read", error instanceof Error ? error.message : error);
          return null;
        })
      : null;
    // Its opener is, at first, its only member: they get its link, and what went over until it is live. The same
    // component before and after it opens, so the result replaces the form where it stood.
    const opened = sliceRead?.[0] ?? null;
    const mine = opened?.by === access.user.id;
    const slice = sliceRead
      ? {
          opened: opened ? { name: opened.name, slug: opened.slug, live: opened.live, opened: utcDay(opened.startedAt), vendors: opened.vendors, canOpen: mine } : null,
          start:
            opened && (opened.live || !mine) ? undefined : (
              <LiveSliceStart
                orgSlug={slug}
                vendors={sliceRead[1]}
                canStart={canAnswer}
                opened={opened ? { name: opened.name, slug: opened.slug, vendors: opened.vendors, skipped: opened.skipped } : null}
              />
            ),
        }
      : undefined;
    // A bill the business recorded paying outside Vestiarion is not "not paid yet".
    const value = reportValue(report, baseline, paidOutside(actuals));
    const comparison = actuals.available ? compareActuals(facts, actuals.facts) : null;
    // Each amount in its own currency, then in the reporting currency with its rates, and the FX variance on paid bills
    // (currency provenance M8). Its parts are each best effort, said as unknown or not set up where they fail.
    const currencies = await readCurrencyReport(db(), facts, actuals.available ? actuals.facts.records : null, new Date(facts.now));
    // Who recorded each, who made each link and who answered, by email, as Approvals names approvers. Best effort: a
    // name that cannot be read is a member's.
    const named =
      comparison?.rows.some((row) => row.actual?.recordedBy) ||
      (shares.available && shares.live.some((share) => share.createdBy)) ||
      (baseline.available && Boolean(baseline.answer?.answeredBy));
    const members: Record<string, string> = named
      ? Object.fromEntries(
          (
            await listMembers(access.membership.orgId).catch((error: unknown) => {
              console.error("report: members not read", error instanceof Error ? error.message : error);
              return [];
            })
          ).map((member) => [member.userId, member.email])
        )
      : {};
    // Whether a bank statement can be imported, and the accounts named before: for someone who may record only. Best
    // effort, as the members: the card is a way to record, not a figure of the report. A read that fails for another
    // reason than the missing migration offers the card with no accounts, and the import says itself what stops it.
    const statement =
      canRecord && comparison
        ? await readStatementSetup(db()).catch((error: unknown) => {
            console.error("report: bank statement setup not read", error instanceof Error ? error.message : error);
            return { available: true, accounts: [] };
          })
        : null;
    const notRecorded = comparison?.rows.filter((row) => row.actual === null && row.agent.stance !== "none") ?? [];
    const templateCsv =
      canRecord && notRecorded.length > 0
        ? actualsCsvTemplate(notRecorded.map((row) => ({ id: row.invoiceId, memo: null, payee: row.payee, amount: row.bill.amount, currency: row.bill.currency, bill: null, dueDate: row.dueDate, current: null })))
        : null;
    const answer = baseline.available ? baseline.answer : null;
    const liveLinks = shares.available
      ? shares.live.map((share) => {
          const shows = shareOptionWords(share.options).join(", ");
          return {
            id: share.id,
            shows: `${shows.charAt(0).toUpperCase()}${shows.slice(1)}`,
            by: share.createdBy ? (members[share.createdBy] ?? null) : null,
            createdAt: share.createdAt,
          };
        })
      : [];

    return (
      <ProductShell network={access.membership.network} day={dashboardStats.day} clockMode={dashboardStats.clockMode} lastCycleAt={dashboardStats.lastCycleAt} chainModes={shellModes()} status={await shellStatus()}>
        <PageHead
          title={sectionTitle("report")}
          sub="What the agent did with this workspace's bills since it opened: what it paid and with what proof, what it stopped and why, and how often a person stepped in."
          right={
            <div className="flex flex-wrap items-center gap-2">
              {canShare && <ReportShareButton orgSlug={slug} available={shares.available} />}
              <DocsLink href="/docs/guides/report" topic="reading the report" />
            </div>
          }
        />
        <div className="space-y-8">
          <WorkspaceReport
            slug={slug}
            report={report}
            slice={slice}
            value={
              <ReportValue
                value={value}
                audience="member"
                answeredBy={answer?.answeredBy ? (members[answer.answeredBy] ?? null) : null}
                answer={
                  canAnswer && baseline.available ? (
                    <ReportBaselineControl orgSlug={slug} current={answer ? { minutesPerBill: answer.minutesPerBill, peoplePerBill: answer.peoplePerBill } : null} />
                  ) : undefined
                }
              />
            }
            actuals={<ActualsComparison slug={slug} comparison={comparison} canRecord={canRecord && comparison !== null} members={members} templateCsv={templateCsv} statement={statement} showAll={query.actuals === "all"} />}
          />
          <CurrencyReport report={currencies} settingsHref={orgHref(slug, "/settings#reporting-currency-title")} asOf={facts.now} />
          {shares.available && <ReportShareLinks orgSlug={slug} live={liveLinks} stopped={shares.stopped} canStop={canShare} />}
        </div>
      </ProductShell>
    );
  });
}
