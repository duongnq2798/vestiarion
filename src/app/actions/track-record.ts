"use server";

import "server-only";

import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { simulatesPayments } from "@/lib/capability-read";
import { utcDay } from "@/lib/copy";
import { inOrg } from "@/lib/dal/scope";
import { takeTrackRecordDownloadToken } from "@/lib/rate-limit";
import { confirmedBy, TRACK_RECORD_CHANGED } from "@/lib/track-record/build";
import { readTrackRecord } from "@/lib/track-record/read";
import { recordTrackRecordConfirmation } from "@/lib/track-record/record";

/** What Confirm this track record answers (track record TR5). */
export interface TrackRecordConfirmAnswer {
  ok: boolean;
  message: string;
  /** The confirmation's entry, when one was signed now. */
  seq?: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Confirms the agent's track record (docs/superpowers/specs/2026-11-07-track-record-design.md TR4, TR5), for an
 * accountant of the workspace only. The SHA-256 the page showed is sent; the record is read again and confirmed only if
 * it is still that one, and only once per person. The entry is signed, not best effort: one that fails says so.
 */
export async function confirmTrackRecordAction(orgSlug: string, shownSha256: string): Promise<TrackRecordConfirmAnswer> {
  const auth = await authorize(orgSlug, "track_record.confirm");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (typeof shownSha256 !== "string" || !SHA256.test(shownSha256)) return { ok: false, message: TRACK_RECORD_CHANGED };
  if (!takeTrackRecordDownloadToken(`${auth.user.id}:${auth.membership.orgId}`)) {
    return { ok: false, message: "Too many tries in a row. Try again in a minute." };
  }
  return inOrg(auth, async () => {
    try {
      const record = await readTrackRecord({
        workspace: { slug: auth.membership.slug, name: auth.membership.name },
        sandbox: simulatesPayments(auth.membership.mode),
        people: "id",
      });
      if (record.contentSha256 !== shownSha256) return { ok: false, message: TRACK_RECORD_CHANGED };
      if (record.totals.given === 0) return { ok: false, message: "There is no verdict on a real bill yet, so there is nothing to confirm." };
      const already = confirmedBy(record, auth.user.id);
      if (already) return { ok: true, message: `You confirmed this track record on ${utcDay(already.at)}.` };
      const entry = await recordTrackRecordConfirmation({ userId: auth.user.id, role: auth.membership.role, record });
      revalidateOrgPages();
      return { ok: true, message: "Confirmed. Your confirmation is signed in the ledger.", seq: entry.seq };
    } catch (error) {
      console.error("track record confirmation failed", error instanceof Error ? error.message.slice(0, 160) : "unknown error");
      return { ok: false, message: "The track record was not confirmed. Try again in a moment." };
    }
  });
}
