import type { Metadata } from "next";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Callout } from "@/components/ui/Callout";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcMinute } from "@/lib/copy";
import { readStatusFile, STATUS_BRANCH_URL, STATUS_FILE_URL } from "@/lib/status/file";
import { PAUSED_AFTER_MINUTES, share, summarize, type CheckSummary, type HourCell, type Incident, type StatusSummary } from "@/lib/status/summary";

/** The file is kept 60 seconds, and so is the page (status page SP6). */
export const revalidate = 60;

export const metadata: Metadata = {
  title: "Status",
  description:
    "Whether Vestiarion's public pages answer, checked about every 10 minutes from GitHub's servers, outside Vercel and Supabase: the last round, the last 24 hours and 7 days of each check, and every incident.",
  alternates: { canonical: "/status" },
};

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** "2 h 20 min" from two instants. */
function lasted(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
}

/**
 * The status page (docs/superpowers/specs/2026-11-04-status-page-design.md): the production check's rounds of the last
 * 7 days, read from the repository's `status` branch on GitHub, which the check replaces after every round. Nothing
 * here reads Vestiarion's own database. A file that cannot be read says so and links the branch, and the page still
 * answers 200.
 */
export default async function StatusPage() {
  const file = await readStatusFile();
  const summary = file ? summarize(file, new Date()) : null;

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <main id="main" className="flex-1">
        <Section>
          <header className="max-w-3xl">
            <p className="flex flex-wrap items-center gap-3">
              <Eyebrow className="text-agent">Status</Eyebrow>
              {summary && <HeadlineBadge summary={summary} />}
            </p>
            <Heading as="h1" size="section" className="mt-3 text-ink">Vestiarion status</Heading>
            <p className="mt-5 text-lede leading-relaxed text-ink-2">
              Whether Vestiarion&apos;s public pages answer, as the production check finds them. It opens each one from GitHub&apos;s servers, outside
              Vercel and Supabase, about every 10 minutes, and publishes every round of the last 7 days to this repository&apos;s{" "}
              <a href={STATUS_BRANCH_URL} className="font-medium text-agent underline underline-offset-2">status branch</a>, which this page reads. If
              this site does not answer, the same results are there.
            </p>
          </header>

          {summary === null ? (
            <Callout tone="held" className="mt-10 max-w-3xl" title="The status could not be read right now.">
              This page reads the production check&apos;s results from GitHub, and GitHub did not give them. That says nothing about the site itself.
              See the <a href={STATUS_BRANCH_URL} className="font-medium underline underline-offset-2">status branch</a> on GitHub, or try again in a
              minute.
            </Callout>
          ) : (
            <StatusBody summary={summary} />
          )}

          <section aria-labelledby="covers" className="mt-16 max-w-3xl border-t border-line pt-10">
            <h2 id="covers" className="text-lg font-semibold text-ink">What it checks, and what it does not</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-ink-2">
              <li>
                Each round opens the landing page, the open numbers, the docs, every free tool, robots.txt and the sitemap with a plain request, as
                anyone could. A check fails when the page does not answer within 15 seconds, answers another status than 200 or redirects, lacks the
                text it must show, or takes longer than its time budget: 8 seconds for the landing page and the open numbers, which read the database,
                and 4 for the rest.
              </li>
              <li>
                It does not check the API, which needs a key, the pages behind a sign-in, the agent&apos;s cycles, payments, Circle or Arc. A page that
                answers here can still fail for a signed-in workspace.
              </li>
              <li>
                GitHub starts the check&apos;s runs once an hour, and sometimes late, so the rounds can pause, for up to about 3 hours so far. An hour
                with no round shows as not checked, never as passing, and the rounds that ran are counted against the ones a round every 10 minutes
                makes. A last round more than {PAUSED_AFTER_MINUTES} minutes old shows as paused.
              </li>
              <li>
                This page keeps the results a minute, and GitHub keeps the file up to 5 minutes, so it can be about 6 minutes behind the last round.
                The file itself: <a href={STATUS_FILE_URL} className="font-mono text-xs text-agent underline underline-offset-2">status.json</a>.
              </li>
            </ul>
          </section>
        </Section>
      </main>
      <SiteFooter />
    </div>
  );
}

function HeadlineBadge({ summary }: { summary: StatusSummary }) {
  const { headline } = summary;
  if (headline.kind === "passing") return <Badge tone="proof" size="sm" dot>{`All ${headline.checks} checks passing`}</Badge>;
  if (headline.kind === "failing") return <Badge tone="refused" size="sm" dot>{`${headline.failing.length} of ${headline.checks} checks failing`}</Badge>;
  if (headline.kind === "paused") return <Badge tone="held" size="sm" dot>{`Checks paused since ${clock(headline.since)}`}</Badge>;
  return <Badge tone="neutral" size="sm">No round yet</Badge>;
}

function StatusBody({ summary }: { summary: StatusSummary }) {
  const { headline, coverage } = summary;
  return (
    <>
      <div className="mt-10 max-w-3xl space-y-4">
        {headline.kind === "passing" && (
          <Callout tone="proof" title={`All ${headline.checks} checks passed in the last round.`}>
            The last round ran at <time dateTime={summary.updatedAt ?? undefined}>{summary.updatedAt ? utcMinute(summary.updatedAt) : ""}</time>.
          </Callout>
        )}
        {headline.kind === "failing" && (
          <Callout tone="refused" title={`${plural(headline.failing.length, "check")} failed in the last round: ${headline.failing.join(", ")}.`}>
            The last round ran at <time dateTime={summary.updatedAt ?? undefined}>{summary.updatedAt ? utcMinute(summary.updatedAt) : ""}</time>. Each
            check below gives its reason. The team is told on its own channel when a check fails two rounds running.
          </Callout>
        )}
        {headline.kind === "paused" && (
          <Callout tone="held" title={`No round has run since ${utcMinute(headline.since)}.`}>
            GitHub starts the check&apos;s runs once an hour and sometimes late, so the rounds pause until it starts the next one. Until then this page
            shows the last results it has
            {headline.failing.length > 0 ? `, in which ${plural(headline.failing.length, "check")} failed: ${headline.failing.join(", ")}.` : ", in which every check passed."}
          </Callout>
        )}
        {headline.kind === "none" && <Callout title="No round has run yet.">The checks have not published a round in the last 7 days.</Callout>}
        <p className="text-sm text-ink-2">
          Rounds that ran: {coverage.day.toLocaleString("en-US")} of the {coverage.dayExpected.toLocaleString("en-US")} in the last 24 hours, and{" "}
          {coverage.week.toLocaleString("en-US")} of the {coverage.weekExpected.toLocaleString("en-US")} in the last 7 days, at one every{" "}
          {summary.everyMinutes} minutes. Read <time dateTime={summary.readAt}>{utcMinute(summary.readAt)}</time>.
        </p>
      </div>

      <section aria-labelledby="checks" className="mt-12">
        <h2 id="checks" className="text-lg font-semibold text-ink">Each check</h2>
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {summary.checks.map((check) => (
            <CheckRow key={check.path} check={check} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="incidents" className="mt-12 max-w-3xl">
        <h2 id="incidents" className="text-lg font-semibold text-ink">Incidents in the last 7 days</h2>
        <p className="mt-2 text-sm text-ink-2">A check that failed two rounds running, the rule the team is told by. A single failed round shows in its hour above.</p>
        {summary.incidents.length === 0 ? (
          <EmptyState className="mt-4" title="No incident in the last 7 days." body="No check failed two rounds running." />
        ) : (
          <ul className="mt-4 space-y-3">
            {summary.incidents.map((incident) => (
              <IncidentRow key={`${incident.path}-${incident.since}`} incident={incident} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const CELL: Record<HourCell["state"], string> = {
  passed: "bg-proof",
  failed: "bg-refused",
  none: "bg-line",
};

function hourWords(cell: HourCell): string {
  const hour = `${clock(cell.start).slice(0, 5)} to ${clock(new Date(Date.parse(cell.start) + 3_600_000).toISOString())}`;
  if (cell.state === "none") return `${hour}: not checked`;
  if (cell.state === "passed") return `${hour}: passed ${plural(cell.rounds, "round")}`;
  return `${hour}: failed ${cell.failed} of ${plural(cell.rounds, "round")}`;
}

function CheckRow({ check }: { check: CheckSummary }) {
  const failedHours = check.hours.filter((cell) => cell.state === "failed").length;
  const unchecked = check.hours.filter((cell) => cell.state === "none").length;
  const day = share(check.day);
  const week = share(check.week);
  return (
    <li className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,16rem)] md:items-center md:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{check.name}</p>
        <p className="truncate font-mono text-xs text-ink-3">{check.path}</p>
      </div>
      <div className="min-w-0">
        {check.last === null ? (
          <Badge size="sm">Not checked yet</Badge>
        ) : check.last.ok ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <Badge tone="proof" size="sm" dot>Passing</Badge>
            <span>
              {check.last.ms.toLocaleString("en-US")} ms at {clock(check.last.at)}
            </span>
          </p>
        ) : (
          <div className="space-y-1 text-sm text-ink-2">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="refused" size="sm" dot>Failing</Badge>
              <span>at {clock(check.last.at)}</span>
            </p>
            <p className="break-words">{check.last.reason}</p>
          </div>
        )}
        <p className="mt-2 text-xs text-ink-3">
          Passed {day ?? "no round"} of the last 24 hours&apos; rounds ({check.day.rounds.toLocaleString("en-US")}), {week ?? "no round"} of the last 7
          days&apos; ({check.week.rounds.toLocaleString("en-US")}).
        </p>
      </div>
      <div className="min-w-0">
        <p className="sr-only">
          Last 24 hours, hour by hour: {24 - failedHours - unchecked} passed every round, {failedHours} had a failed round, {unchecked} not checked.
        </p>
        <div aria-hidden className="flex h-6 gap-px">
          {check.hours.map((cell) => (
            <span key={cell.start} title={hourWords(cell)} className={cn("min-w-0 flex-1 rounded-[2px]", CELL[cell.state])} />
          ))}
        </div>
        <p aria-hidden className="mt-1 flex justify-between text-[0.6875rem] text-ink-3">
          <span>24 h ago</span>
          <span>now</span>
        </p>
      </div>
    </li>
  );
}

function IncidentRow({ incident }: { incident: Incident }) {
  return (
    <li className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{incident.name}</span>
        <span className="font-mono text-xs text-ink-3">{incident.path}</span>
        {incident.until === null ? <Badge tone="refused" size="sm">Still failing</Badge> : <Badge size="sm">Passed again</Badge>}
      </p>
      <p className="mt-1">
        From <time dateTime={incident.since}>{utcMinute(incident.since)}</time>
        {incident.until === null ? (
          <>, {plural(incident.failedRounds, "failed round")} so far.</>
        ) : (
          <>
            {" "}to{" "}
            <time dateTime={incident.until}>{incident.until.slice(0, 10) === incident.since.slice(0, 10) ? clock(incident.until) : utcMinute(incident.until)}</time>,{" "}
            {lasted(incident.since, incident.until)},{" "}
            {plural(incident.failedRounds, "failed round")}.
          </>
        )}{" "}
        First reason: {incident.reason}.
      </p>
    </li>
  );
}
