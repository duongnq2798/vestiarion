import type { Metadata } from "next";
import { connection } from "next/server";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/EmptyState";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcMinute } from "@/lib/copy";
import { ISSUES_URL } from "@/lib/site-links";
import { readStatusFile, STATUS_BRANCH_URL, STATUS_FILE_URL } from "@/lib/status/file";
import { PAUSED_AFTER_MINUTES, summarize, type CheckSummary, type HourCell, type Incident, type RoundCount, type StatusSummary } from "@/lib/status/summary";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Whether Vestiarion's public pages are up, checked about every 10 minutes by a monitor on GitHub's servers, outside Vestiarion's own hosting: the last check, each page's last 24 hours and 7 days, and the incidents of the last 7 days.",
  alternates: { canonical: "/status" },
};

const LINK = "font-medium text-agent underline underline-offset-2";
const count = (value: number) => value.toLocaleString("en-US");
const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;
/** The time alone when it is on `sameDayAs`'s day, the date too when it is not. */
const timeOf = (iso: string, sameDayAs: string) => (iso.slice(0, 10) === sameDayAs.slice(0, 10) ? clock(iso) : utcMinute(iso));
/** The branch's address as text, so it can be kept for a day this site does not answer. */
const BRANCH_TEXT = STATUS_BRANCH_URL.replace(/^https:\/\//, "");

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
 * here reads Vestiarion's own database. Readers see a "monitor" that checks "pages": on a bills product, "checks" alone
 * reads as payments. A file not published yet, or one that cannot be read, says so and links the branch, and the page
 * still answers 200.
 */
export default async function StatusPage() {
  // Rendered for each visit, with the file read for it, so whether the monitor paused is worked out from the time of
  // the visit, never from an older copy of the page or of the file (SP6).
  await connection();
  const read = await readStatusFile();
  const summary = read.state === "read" ? summarize(read.file, new Date()) : null;
  const hasResults = summary !== null && summary.headline.kind !== "none";

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
              Whether Vestiarion&apos;s public pages are up. A monitor on GitHub&apos;s servers, outside Vestiarion&apos;s own hosting, opens each page
              about every 10 minutes. If this site is down, the same results are on GitHub at{" "}
              <a href={STATUS_BRANCH_URL} className={cn(LINK, "break-words")}>{BRANCH_TEXT}</a>.
            </p>
          </header>

          {summary === null || !hasResults ? (
            <NoResults state={read.state === "unreadable" ? "unreadable" : "missing"} />
          ) : (
            <StatusBody summary={summary} />
          )}

          <section aria-labelledby="covers" className="mt-16 max-w-3xl border-t border-line pt-10">
            <h2 id="covers" className="text-lg font-semibold text-ink">What the monitor checks, and what it does not</h2>
            <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-ink-2">
              <li>
                Each time, it opens the landing page, the open numbers, the docs, each free tool, and the two files search engines read
                (robots.txt and the sitemap), as any visitor would. A page fails when it does not answer within 15 seconds, answers with an error or a
                redirect, is missing the text it must show or shows a text it must not, or is slower than its limit: 8 seconds for the landing page and
                the open numbers, which read the database, and 4 for the rest.
              </li>
              <li>
                It does not check the API, which needs a key, the pages behind a sign-in, the agent&apos;s work, payments, Circle or Arc. A page that is
                up here can still fail for a signed-in workspace.
              </li>
              <li>
                GitHub is set to start the monitor every hour, and each run checks every 10 minutes for almost 6 hours, but GitHub has started runs
                late, so monitoring has paused, so far for up to about 3 hours. Those hours show as not checked, never as up. A last check more than{" "}
                {PAUSED_AFTER_MINUTES} minutes old shows as paused.
              </li>
              <li>
                This page reads the results each time it opens, from GitHub, which keeps them up to 5 minutes, so it is at most about 5 minutes
                behind the last check. The file itself: <a href={STATUS_FILE_URL} className={cn(LINK, "font-mono text-xs")}>status.json</a>.
              </li>
              <li>
                Something wrong that this page does not show? Tell us on <a href={ISSUES_URL} className={LINK}>GitHub Issues</a>.
              </li>
            </ul>
          </section>
        </Section>
      </main>
      <SiteFooter compact />
    </div>
  );
}

function HeadlineBadge({ summary }: { summary: StatusSummary }) {
  const { headline } = summary;
  if (headline.kind === "passing") return <Badge tone="proof" size="sm" dot>{`All ${headline.checks} pages up`}</Badge>;
  if (headline.kind === "failing") return <Badge tone="refused" size="sm" dot>{`${headline.failing.length} of ${headline.checks} pages failing`}</Badge>;
  if (headline.kind === "paused") return <Badge tone="held" size="sm" dot>{`Monitoring paused since ${utcMinute(headline.since)}`}</Badge>;
  return <Badge tone="neutral" size="sm">No results yet</Badge>;
}

function NoResults({ state }: { state: "missing" | "unreadable" }) {
  if (state === "missing") {
    return (
      <Callout className="mt-10 max-w-3xl" title="No results yet.">
        The monitor has not published any results yet. The first are published within a few hours, here and on GitHub.
      </Callout>
    );
  }
  return (
    <Callout tone="held" className="mt-10 max-w-3xl" title="The results could not be read right now.">
      This page reads the monitor&apos;s results from GitHub, and GitHub did not give a file this page can read. That does not mean Vestiarion is
      down. See the results on <a href={STATUS_BRANCH_URL} className="font-medium underline underline-offset-2">GitHub</a>, or try again in a
      minute.
    </Callout>
  );
}

function StatusBody({ summary }: { summary: StatusSummary }) {
  const { headline, coverage } = summary;
  const paused = headline.kind === "paused";
  const last = summary.updatedAt ?? summary.readAt;
  // The pages that failed at the last check first, then the rest in the monitor's order.
  const checks = [...summary.checks].sort((a, b) => Number(a.last?.ok !== false) - Number(b.last?.ok !== false));
  const issues = (
    <>
      Something wrong that this page does not show? Tell us on <a href={ISSUES_URL} className="font-medium underline underline-offset-2">GitHub Issues</a>.
    </>
  );
  return (
    <>
      <div className="mt-10 max-w-3xl space-y-4">
        {headline.kind === "passing" && (
          <Callout tone="proof" title={`All ${headline.checks} pages were up at the last check.`}>
            Last checked <time dateTime={last}>{utcMinute(last)}</time>.
          </Callout>
        )}
        {headline.kind === "failing" && (
          <Callout tone="refused" title={`${headline.failing.length} of ${headline.checks} pages failed at the last check: ${headline.failing.join(", ")}.`}>
            Last checked <time dateTime={last}>{utcMinute(last)}</time>. Each page below gives the reason. The team gets an alert when a page fails
            twice in a row. {issues}
          </Callout>
        )}
        {headline.kind === "paused" && (
          <Callout tone="held" title={`Monitoring paused: nothing checked since ${utcMinute(headline.since)}.`}>
            GitHub sometimes starts the monitor late, and nothing is checked until it does. That does not mean Vestiarion is down. Below are the
            results of the last check
            {headline.failing.length > 0 ? `, when ${plural(headline.failing.length, "page")} failed: ${headline.failing.join(", ")}.` : ", when every page was up."}
          </Callout>
        )}
        <p className="text-sm text-ink-2">
          {coverage.keptSince && (
            <>
              The results kept begin <time dateTime={coverage.keptSince}>{utcMinute(coverage.keptSince)}</time>, when the monitor first published
              them, so the checks it should have run are counted from then.{" "}
            </>
          )}
          In the last 24 hours the monitor ran {count(coverage.day)} of the {count(coverage.dayExpected)} times it should have, and{" "}
          {count(coverage.week)} of {count(coverage.weekExpected)} in the last 7 days. This page read the results{" "}
          <time dateTime={summary.readAt}>{utcMinute(summary.readAt)}</time>.
        </p>
      </div>

      <section aria-labelledby="pages" className="mt-12">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="pages" className="text-lg font-semibold text-ink">Each page</h2>
          <Legend />
        </div>
        <ul className="mt-4 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
          {checks.map((check) => (
            <CheckRow key={check.path} check={check} paused={paused} expected={{ day: coverage.dayExpected, week: coverage.weekExpected }} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="incidents" className="mt-12 max-w-3xl">
        <h2 id="incidents" className="text-lg font-semibold text-ink">Incidents in the last 7 days</h2>
        <p className="mt-2 text-sm text-ink-2">
          A page that failed twice in a row, when the team gets an alert. A single failure shows in its hour above.
        </p>
        {summary.incidents.length === 0 ? (
          <EmptyState className="mt-4" title="No incident in the last 7 days." body="No page failed twice in a row." />
        ) : (
          <ul className="mt-4 space-y-3">
            {summary.incidents.map((incident) => (
              <IncidentRow key={`${incident.path}-${incident.since}`} incident={incident} paused={paused} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Each hour of the strip: up a shorter bar, a failure a full one, not checked a hatched one, so colour is never alone. */
const CELL: Record<HourCell["state"], string> = {
  passed: "h-4 bg-proof",
  failed: "h-6 bg-refused",
  none: "h-4 hatch bg-line",
};

/** The legend's swatches: each cell's shape and colour, smaller. */
const SWATCH: Record<HourCell["state"], string> = {
  passed: "h-2 bg-proof",
  failed: "h-3 bg-refused",
  none: "h-2 hatch bg-line",
};

function Legend() {
  const items: Array<[HourCell["state"], string]> = [
    ["passed", "Up every check"],
    ["failed", "A failure"],
    ["none", "Not checked"],
  ];
  return (
    <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
      <span>Last 24 hours, by the hour:</span>
      {items.map(([state, label]) => (
        <span key={state} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn("inline-block w-2", SWATCH[state])} />
          {label}
        </span>
      ))}
    </p>
  );
}

const hourSpan = (cell: HourCell) => `${clock(cell.start).slice(0, 5)} to ${clock(new Date(Date.parse(cell.start) + 3_600_000).toISOString())}`;

function hourWords(cell: HourCell): string {
  if (cell.state === "none") return `${hourSpan(cell)}: not checked`;
  if (cell.state === "passed") return `${hourSpan(cell)}: up all ${plural(cell.rounds, "time")} checked`;
  return `${hourSpan(cell)}: failed ${cell.failed} of ${plural(cell.rounds, "time")} checked`;
}

/** "passed 126 of 126 times checked, 18 missed", or "not checked" when it never ran in the window. */
function times(window: RoundCount, expected: number): string {
  if (window.rounds === 0) return "not checked";
  const missed = Math.max(0, expected - window.slots);
  return `up ${count(window.passed)} of ${plural(window.rounds, "time")} checked${missed > 0 ? `, ${count(missed)} missed` : ""}`;
}

function CheckRow({ check, paused, expected }: { check: CheckSummary; paused: boolean; expected: { day: number; week: number } }) {
  const failedHours = check.hours.filter((cell) => cell.state === "failed");
  const unchecked = check.hours.filter((cell) => cell.state === "none").length;
  const upHours = 24 - failedHours.length - unchecked;
  return (
    <li className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,16rem)] md:items-center md:gap-6">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">{check.name}</p>
        <p className="truncate font-mono text-xs text-ink-3">{check.path}</p>
      </div>
      <div className="min-w-0">
        {check.last === null ? (
          <Badge size="sm">Not checked yet</Badge>
        ) : paused ? (
          // Nothing was checked for a while: the last result, as it was then, never as the page's state now.
          <div className="space-y-1 text-sm text-ink-2">
            <p>
              <Badge size="sm">{`${check.last.ok ? "Up" : "Failed"} at ${clock(check.last.at)}`}</Badge>
            </p>
            {!check.last.ok && <p className="break-words">{check.last.reason}</p>}
          </div>
        ) : check.last.ok ? (
          <p className="flex flex-wrap items-center gap-2 text-sm text-ink-2">
            <Badge tone="proof" size="sm" dot>Up</Badge>
            <span>
              {count(check.last.ms)} ms at {clock(check.last.at)}
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
          Last 24 hours: {times(check.day, expected.day)}. Last 7 days: {times(check.week, expected.week)}.
        </p>
      </div>
      <div className="min-w-0">
        <p className="sr-only">
          Last 24 hours, by the hour: {plural(upHours, "hour")} up every check,{" "}
          {failedHours.length === 0 ? "none with a failure" : `${plural(failedHours.length, "hour")} with a failure (${failedHours.map(hourSpan).join(", ")})`},{" "}
          {plural(unchecked, "hour")} not checked.
        </p>
        <div aria-hidden className="flex h-6 items-end gap-px">
          {check.hours.map((cell) => (
            <span key={cell.start} title={hourWords(cell)} className={cn("min-w-0 flex-1", CELL[cell.state])} />
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

function IncidentRow({ incident, paused }: { incident: Incident; paused: boolean }) {
  return (
    <li className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{incident.name}</span>
        <span className="font-mono text-xs text-ink-3">{incident.path}</span>
        {incident.until !== null ? (
          <Badge size="sm">Up again</Badge>
        ) : paused ? (
          <Badge tone="held" size="sm">Failing when monitoring paused</Badge>
        ) : (
          <Badge tone="refused" size="sm">Still failing</Badge>
        )}
      </p>
      <p className="mt-1 break-words">
        {incident.startedEarlier ? "Already failing at the oldest result kept, " : "From "}
        <time dateTime={incident.since}>{utcMinute(incident.since)}</time>
        {incident.until === null ? (
          <>, failed {plural(incident.failedRounds, "time")} in a row so far.</>
        ) : (
          <>
            {" "}to <time dateTime={incident.until}>{timeOf(incident.until, incident.since)}</time>, {lasted(incident.since, incident.until)}, failed{" "}
            {plural(incident.failedRounds, "time")} in a row.
          </>
        )}{" "}
        First reason: {incident.reason}.
      </p>
    </li>
  );
}
