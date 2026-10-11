"use client";

import { Link2, Link2Off, Share2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { shareReportAction, stopSharingReportAction, type ReportShareActionResult } from "@/app/actions/report-share";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { plural, utcDay } from "@/lib/copy";

/**
 * Sharing the workspace report by a public link (docs/superpowers/specs/2026-10-10-shared-report-design.md S2, S3, S4,
 * S13). An owner or admin chooses what the shared copy shows and makes a link, shown once with Copy; every member sees
 * the live links, who made each and what it shows, and an owner or admin stops one. Before migration 0095 runs, the
 * dialog says sharing is not set up, and has no form.
 */

const INITIAL: ReportShareActionResult = { ok: false, message: "" };

const NAMES = [
  { value: "labels", label: "Labels: Supplier A, Supplier B", description: "In the same order as each supplier's first bill, in the agent's reasoning too." },
  { value: "shown", label: "Their names" },
] as const;
const AMOUNTS = [
  { value: "shown", label: "Show amounts" },
  { value: "hidden", label: "Hide every amount", description: "Bills, payments, sums and discounts, and the links to transactions, whose explorer page shows the amount. The counts stay." },
] as const;
const TITLES = [
  { value: "workspace", label: "This workspace's name" },
  { value: "neutral", label: "A business on Vestiarion" },
] as const;

/** The report's Share this report button, for an owner or admin: the options, then the link, shown once. */
export function ReportShareButton({ orgSlug, available }: { orgSlug: string; available: boolean }) {
  const router = useRouter();
  const [url, setUrl] = useState<string | null>(null);
  const share = useActionForm(shareReportAction, INITIAL, {
    onResult: (result) => {
      setUrl(result.ok && result.url ? result.url : null);
      if (result.ok) router.refresh();
    },
  });
  const error = !share.state.ok && share.state.message ? share.state.message : null;

  return (
    <Dialog onOpenChange={(open) => !open && setUrl(null)}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" icon={<Share2 />}>
          Share this report
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Share this report"
        description="Anyone with the link sees a live copy of this report, without signing in, until you stop sharing it."
      >
        {!available ? (
          <p className="text-sm text-ink-2">Sharing the report is not set up on this deployment yet.</p>
        ) : url ? (
          <div className="grid gap-4">
            <SharedLink url={url} message={share.state.message} />
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Done</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <form {...share.formProps} className="grid gap-5">
            <input type="hidden" name="orgSlug" value={orgSlug} />
            <RadioGroup legend="Supplier names" name="names" defaultValue="labels" options={NAMES} />
            <RadioGroup legend="Amounts" name="amounts" defaultValue="shown" options={AMOUNTS} />
            <RadioGroup legend="Title" name="title" defaultValue="workspace" options={TITLES} />
            <p className="text-xs leading-relaxed text-ink-3">
              Never shown: memos, notes, references, invoice ids, or the names and emails of this workspace&apos;s members. The agent&apos;s reasoning is its
              first sentence, with any email, 0x address or id hidden. With amounts shown, a payment on chain links to its transaction on the public explorer,
              which shows its amount and the address it was paid to.
            </p>
            <FormMessage tone="error">{error}</FormMessage>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <SubmitButton icon={<Link2 />} pendingLabel="Making the link…">
                Make the link
              </SubmitButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** A link just made, shown once: the field beside Copy, scrolling a long link inside itself. */
function SharedLink({ url, message }: { url: string; message: string }) {
  return (
    <div className="w-full min-w-0 space-y-1.5 rounded-lg border border-line bg-surface p-2.5">
      <div className="flex w-full min-w-0 items-center gap-2">
        <Input readOnly value={url} aria-label="Report link" className="min-w-0 flex-1 font-mono text-xs" onFocus={(event) => event.currentTarget.select()} />
        <CopyButton value={url} size="sm" variant="secondary" label="Copy the report link" />
      </div>
      <p className="text-xs leading-5 text-ink-3">{message}</p>
    </div>
  );
}

export interface LiveLink {
  id: string;
  /** What it shows, in words. */
  shows: string;
  /** Who made it, by email; null when the person is no longer known. */
  by: string | null;
  createdAt: string;
}

/** The report's live links, for every member; an owner or admin stops one. */
export function ReportShareLinks({ orgSlug, live, stopped, canStop }: { orgSlug: string; live: LiveLink[]; stopped: number; canStop: boolean }) {
  return (
    <section aria-labelledby="report-links" className="space-y-3">
      <SectionHeader
        id="report-links"
        title="Shared links"
        meta={`${live.length} live${stopped > 0 ? ` · ${stopped} stopped` : ""}`}
      />
      {live.length === 0 ? (
        <p className="text-sm text-ink-2">
          {canStop
            ? "This report is not shared. Share this report makes a link anyone can open without signing in."
            : "This report is not shared. An owner or admin can share it by a link."}
        </p>
      ) : (
        <Card className="overflow-hidden">
          <ul aria-label="Live links to this report" className="divide-y divide-line">
            {live.map((link) => (
              <LiveLinkRow key={link.id} orgSlug={orgSlug} link={link} canStop={canStop} />
            ))}
          </ul>
        </Card>
      )}
      {live.length > 0 && (
        <p className="text-xs text-ink-3">
          {`Anyone with one of ${plural(live.length, "this link", "these links")} sees a live copy of the report. A link is shown only once, when it is made: one that is lost is stopped and made again.`}
        </p>
      )}
    </section>
  );
}

function LiveLinkRow({ orgSlug, link, canStop }: { orgSlug: string; link: LiveLink; canStop: boolean }) {
  const router = useRouter();
  const stop = useActionForm(stopSharingReportAction, INITIAL, { onSuccess: () => router.refresh() });
  // Each row's Stop sharing names its own link to a screen reader: what it shows and who made it.
  const describedBy = useId();
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div id={describedBy} className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-ink">{link.shows}</p>
        <p className="text-xs text-ink-3">{`Made by ${link.by ?? "a former member"} on ${utcDay(link.createdAt)}`}</p>
        {!stop.state.ok && stop.state.message && <FormMessage tone="error">{stop.state.message}</FormMessage>}
      </div>
      {canStop && (
        <form {...stop.formProps} className="shrink-0">
          <input type="hidden" name="orgSlug" value={orgSlug} />
          <input type="hidden" name="shareId" value={link.id} />
          <SubmitButton size="sm" variant="ghost" icon={<Link2Off />} pendingLabel="Stopping…" aria-describedby={describedBy}>
            Stop sharing
          </SubmitButton>
        </form>
      )}
    </li>
  );
}
