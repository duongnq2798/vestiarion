import type { Metadata } from "next";
import { DocsLink } from "@/components/DocsLink";
import { TrackRecordConfirm } from "@/components/TrackRecordConfirm";
import { TrackRecordView } from "@/components/TrackRecordView";
import { Callout } from "@/components/ui/Callout";
import { PageHead, ProductShell } from "@/components/vx/Shell";
import { requireMembership } from "@/lib/auth/membership";
import { can } from "@/lib/auth/roles";
import { simulatesPayments } from "@/lib/capability-read";
import { shellModes } from "@/lib/circle";
import { utcDay } from "@/lib/copy";
import { inOrg } from "@/lib/dal/scope";
import { shellClock } from "@/lib/queries";
import { takeTrackRecordPageToken } from "@/lib/rate-limit";
import { shellStatus } from "@/lib/shell-status";
import { confirmedBy } from "@/lib/track-record/build";
import { readTrackRecord } from "@/lib/track-record/read";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Track record" };

/**
 * The agent's track record (docs/superpowers/specs/2026-11-07-track-record-design.md TR7): for every member, and
 * confirmed by an accountant only (TR4). A person reads it ten times at once, then once every 6 seconds, since each read
 * checks every cited entry's signature. Reading or printing it writes nothing.
 */
export default async function TrackRecordPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await requireMembership(slug);
  return inOrg(access, async () => {
    const allowed = takeTrackRecordPageToken(access.user.id);
    const [record, clock, status] = await Promise.all([
      allowed
        ? readTrackRecord({
            workspace: { slug: access.membership.slug, name: access.membership.name },
            sandbox: simulatesPayments(access.membership.mode),
            people: "email",
          })
        : null,
      shellClock(),
      shellStatus(),
    ]);
    const canConfirm = can(access.membership.role, "track_record.confirm");
    const mine = record ? confirmedBy(record, access.user.id) : null;
    const download = `/api/evidence/track-record?${new URLSearchParams({ org: access.membership.slug }).toString()}`;

    return (
      <ProductShell
        network={access.membership.network}
        day={clock.day}
        clockMode={clock.clockMode}
        lastCycleAt={clock.lastCycleAt}
        chainModes={shellModes()}
        status={status}
      >
        <PageHead
          title="Track record"
          sub="How often this business agreed with the agent, the vendors that earned its rule, and every verdict behind them, signed, for an accountant to confirm."
          right={
            <div className="print:hidden">
              <DocsLink href="/docs/guides/accountants#confirm-the-agent-s-track-record" topic="the agent's track record" />
            </div>
          }
        />
        {!record && <Callout tone="held">The track record was read many times in a row. Try again in a minute.</Callout>}
        <TrackRecordView
          record={record}
          download={download}
          confirm={
            record && record.totals.given > 0 ? (
              canConfirm ? (
                <TrackRecordConfirm orgSlug={access.membership.slug} sha256={record.contentSha256} confirmedOn={mine ? utcDay(mine.at) : null} />
              ) : (
                <p className="text-sm text-ink-2">An accountant of this workspace confirms it.</p>
              )
            ) : null
          }
        />
      </ProductShell>
    );
  });
}
