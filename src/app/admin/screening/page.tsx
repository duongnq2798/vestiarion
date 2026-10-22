import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ScreeningCheck } from "@/components/admin/ScreeningCheck";
import { Section, Tile } from "@/components/growth/GrowthSections";
import { Callout } from "@/components/ui/Callout";
import { utcMinute } from "@/lib/copy";
import { growthTeamUser } from "@/lib/growth/gate";
import { HEALTH_CHECK_NAME, redactForEnv, screeningSetup } from "@/lib/screening/check";
import { readPlatformScreeningHealth, type PlatformScreeningHealth } from "@/lib/screening/platform-health";
import { failureKindOfNote, SCREENING_FAILURE_WORDS } from "@/lib/screening/providers";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Screening",
  robots: { index: false, follow: false },
};

const counted = (window: PlatformScreeningHealth["day"]) => `${window.complete} complete · ${window.failed} failed`;

/**
 * Whether this deployment's name screening works (docs/superpowers/specs/2026-10-22-screening-health-design.md SH1,
 * SH3), for the team only, behind the founder dashboard's gate: anyone not signed in, or signed in but off
 * platform_team, gets the same 404 as an address that does not exist. Configured is not working: the setup is read from
 * the environment without calling anyone; Check now makes one lookup of a fictitious name; and live checks across
 * workspaces say when screening last worked and last failed. Nothing on the page calls the provider by itself.
 */
export default async function ScreeningHealthPage() {
  const user = await growthTeamUser();
  if (!user) notFound();
  const now = new Date();
  const setup = screeningSetup(process.env);
  const health = await readPlatformScreeningHealth();
  const failedNote = health?.lastFailed?.note ? redactForEnv(health.lastFailed.note, process.env) : null;
  const failedKind = failedNote ? failureKindOfNote(failedNote) : null;

  return (
    <main id="main" className="mx-auto w-full max-w-6xl space-y-10 px-4 py-8 sm:px-6 sm:py-10">
      <header className="space-y-3">
        <p className="font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3">Team only</p>
        <h1 className="text-3xl font-semibold tracking-[-0.03em] text-ink">Screening</h1>
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          Whether this deployment&apos;s name screening answers, not only whether it is configured. Read at {utcMinute(now.toISOString())}. Check now adds no
          counterparty, writes no compliance check and nothing to any ledger.
        </p>
      </header>

      <Section id="setup" title="This deployment" meta="Read from its environment, without calling the provider">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Provider" value={setup.label ?? "None"} muted={!setup.label} />
          <Tile label="Address" value={setup.origin ?? "None"} detail="Its origin only." muted={!setup.origin} />
          <Tile label="Key" value={setup.keySet ? "Set" : "Not set"} detail="Never shown." />
          <Tile label="Variables" value={setup.variableSet ?? "None set"} detail="The SCREENING_* names win over OPENSANCTIONS_* as soon as one is set." muted={!setup.variableSet} />
        </div>
        {setup.problem && (
          <Callout tone="held" title="No lookup can be made">
            {setup.problem}
          </Callout>
        )}
      </Section>

      <Section id="check" title="Check now" meta="One metered lookup of a fictitious company">
        <ScreeningCheck name={HEALTH_CHECK_NAME} />
      </Section>

      <Section id="live" title="Live checks across workspaces" meta="Every workspace's provider lookups: no bundled list, no OFAC address verdict">
        {health === null ? (
          <Callout tone="held" title="The platform read is not there yet">
            Migration 0139 has not run on this database, or the read failed. Check now still works.
          </Callout>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Tile
              label="Last complete"
              value={health.lastComplete ? utcMinute(health.lastComplete.at) : "None"}
              detail={health.lastComplete ? `${health.lastComplete.slug} · ${health.lastComplete.source}` : "No live check has completed."}
              muted={!health.lastComplete}
            />
            <Tile
              label="Last failed"
              value={health.lastFailed ? utcMinute(health.lastFailed.at) : "None"}
              detail={
                health.lastFailed
                  ? `${health.lastFailed.slug}: ${failedNote ?? "no note"}${failedKind ? ` (${SCREENING_FAILURE_WORDS[failedKind]})` : ""}`
                  : "No live check has failed."
              }
              muted={!health.lastFailed}
            />
            <Tile label="Last 24 hours" value={counted(health.day)} />
            <Tile label="Last 7 days" value={counted(health.week)} />
          </div>
        )}
      </Section>

      <Section id="rotate" title="Changing the key">
        <p className="max-w-3xl text-sm leading-relaxed text-ink-2">
          Follow &ldquo;Changing the screening key&rdquo; in docs/self-hosting.md: check the new key locally with <code>npm run screening:check</code>, replace
          only the key&apos;s value in Production, redeploy, then Check now here and read the deployment&apos;s logs for its <code>screening check:</code> line.
          Check now writes no check, so a workspace&apos;s header keeps saying &ldquo;Live, last lookup failed&rdquo;, and the tiles above keep their
          times, until that workspace&apos;s next agent cycle makes a live lookup: that is not a failed rotation.
        </p>
      </Section>
    </main>
  );
}
