"use client";

import { BadgeCheck } from "lucide-react";
import { useState, useTransition } from "react";
import { confirmTrackRecordAction } from "@/app/actions/track-record";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";

/**
 * Confirm this track record, for an accountant (docs/superpowers/specs/2026-11-07-track-record-design.md TR5). It sends
 * the SHA-256 the page showed, so a record that changed since is not confirmed. Mounted whatever the answer, so the
 * message stays once the page is revalidated around it.
 */
export function TrackRecordConfirm({ orgSlug, sha256, confirmedOn }: { orgSlug: string; sha256: string; confirmedOn: string | null }) {
  const [pending, startTransition] = useTransition();
  const [answer, setAnswer] = useState<{ ok: boolean; message: string } | null>(null);

  function confirm() {
    startTransition(async () => {
      try {
        setAnswer(await confirmTrackRecordAction(orgSlug, sha256));
      } catch {
        setAnswer({ ok: false, message: "The track record was not confirmed. Try again in a moment." });
      }
    });
  }

  return (
    <div className="space-y-2">
      {confirmedOn && !answer ? (
        <p className="text-sm text-ink-2">You confirmed this track record on {confirmedOn}.</p>
      ) : (
        <Button icon={<BadgeCheck />} loading={pending} onClick={confirm} disabled={answer?.ok === true}>
          {pending ? "Confirming…" : "Confirm this track record"}
        </Button>
      )}
      <FormMessage tone={answer ? (answer.ok ? "success" : "error") : "neutral"}>{answer?.message}</FormMessage>
    </div>
  );
}
