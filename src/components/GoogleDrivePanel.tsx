"use client";

import { Folder, FolderInput, Link2, Unplug } from "lucide-react";
import Link from "next/link";
import { useId } from "react";
import {
  chooseGoogleDriveFolderAction,
  disconnectGoogleDriveAction,
  type GoogleDriveActionResult,
  type GoogleDriveFolderResult,
} from "@/app/actions/googledrive";
import { DocsLink } from "@/components/DocsLink";
import { GoogleDriveCheck } from "@/components/GoogleDriveCheck";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { orgHref } from "@/lib/auth/org-paths";
import { billsHref } from "@/lib/bills-view";
import type { GoogleDriveFigures, GoogleDriveFolderView, GoogleDrivePanelView } from "@/lib/googledrive/views";

const INITIAL: GoogleDriveActionResult = { ok: false, message: "" };
const CHOOSE_INITIAL: GoogleDriveFolderResult = { ok: false, message: "" };

/** What Google Drive's way back from connecting says, by the code it carries in `?googledrive=` (Google Drive intake GD2). */
export const GOOGLE_DRIVE_NOTICES: Record<string, { tone: "success" | "error"; text: string }> = {
  connected: { tone: "success", text: "Google Drive is connected. Vestiarion reads only the folder chosen on this card." },
  cancelled: { tone: "error", text: "Connecting Google Drive was cancelled. Nothing changed." },
  forbidden: { tone: "error", text: "Only an owner or admin connects Google Drive, from their own browser." },
  other_organisation: { tone: "error", text: "This workspace is connected to another Google account. Disconnect it first, then connect the one you want." },
  scopes: { tone: "error", text: "Google did not give access to read your Drive files, so nothing was connected. Connect again and allow it." },
  not_set_up: { tone: "error", text: "Google Drive is not set up on this deployment yet." },
  failed: { tone: "error", text: "Google Drive did not finish connecting. Try again in a moment." },
};

type ActionForm<State extends GoogleDriveActionResult> = ReturnType<typeof useActionForm<State>>;

const LINK = "font-medium text-agent underline-offset-4 hover:underline";

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** The files left as they were when the folder was chosen (GD5), in words. */
function baselineWords(folder: GoogleDriveFolderView): string {
  if (folder.baseline === 0) return `Chosen on ${folder.chosenOn}, empty.`;
  return `Chosen on ${folder.chosenOn} with ${count(folder.baseline, "file", "files")} in it, which ${folder.baseline === 1 ? "is" : "are"} never read.`;
}

function ConnectButton({ orgSlug, label }: { orgSlug: string; label: string }) {
  return (
    <Button asChild size="sm">
      <Link href={`/integrations/googledrive/connect?org=${orgSlug}`}>
        <Link2 aria-hidden />
        {label}
      </Link>
    </Button>
  );
}

/**
 * The folder's link or ID (GD4): read for the folder's ID alone, never opened. Its form's state lives in
 * `GoogleDrivePanel`: choosing the first folder revalidates the page, which then draws the folder above this form, so
 * the answer is kept by the panel, which stays mounted.
 */
function ChooseFolder({ orgSlug, form, again }: { orgSlug: string; form: ActionForm<GoogleDriveFolderResult>; again: boolean }) {
  const id = useId();
  const answered = form.state;
  return (
    <form {...form.formProps} className="space-y-2">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <label htmlFor={id} className="block text-xs font-semibold text-ink">
        The folder&apos;s link from Google Drive
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          id={id}
          name="folder"
          type="text"
          required
          size="sm"
          placeholder="https://drive.google.com/drive/folders/…"
          className="h-11 sm:h-8"
          maxLength={2000}
          autoComplete="off"
          spellCheck={false}
        />
        <SubmitButton variant="secondary" size="sm" pendingLabel="Choosing…" className="h-11 shrink-0 sm:h-8" icon={<FolderInput aria-hidden />}>
          {again ? "Choose another folder" : "Choose the folder"}
        </SubmitButton>
      </div>
      <p className="text-xs text-ink-3">
        Paste the folder&apos;s link, or its ID. Vestiarion reads the folder through this connection, never by opening the link.
      </p>
      {/* The answer names the folder, whose name Drive may give with no place to break: it wraps anywhere at 375 px. */}
      <FormMessage tone={answered.message && !answered.ok ? "error" : "neutral"} className="[overflow-wrap:anywhere]">
        {answered.message || null}
      </FormMessage>
    </form>
  );
}

/** The folder read, with when it was chosen and last read, and what the last read that did not finish says (GD13). */
function FolderShown({ folder }: { folder: GoogleDriveFolderView }) {
  return (
    <div className="space-y-1">
      {/* A folder's name from Drive, up to 255 characters, may have no place to break. */}
      <p className="text-sm text-ink [overflow-wrap:anywhere]">
        Reading{" "}
        <a href={folder.url} target="_blank" rel="noopener noreferrer" className={LINK}>
          {folder.name}
        </a>{" "}
        in Google Drive
      </p>
      <p className="text-sm text-ink-2">{baselineWords(folder)}</p>
      <p className="text-sm text-ink-2">{folder.lastRead}</p>
      {folder.problem && <p className={folder.askAgain ? "text-sm text-refused" : "text-sm text-held"}>{folder.problem}</p>}
    </div>
  );
}

/** The card's figures (GD15): files read in the last 30 days, waiting for review now, and added as bills. */
function Figures({ orgSlug, figures }: { orgSlug: string; figures: GoogleDriveFigures }) {
  return (
    <dl className="grid grid-cols-1 gap-2 border-t border-line pt-4 text-sm min-[420px]:grid-cols-3">
      <div>
        <dt className="text-xs text-ink-3">Files read in the last 30 days</dt>
        <dd className="font-semibold tabular-nums text-ink">{count(figures.read30d, "file", "files")}</dd>
      </div>
      <div>
        <dt className="text-xs text-ink-3">Waiting for review</dt>
        <dd className="font-semibold tabular-nums text-ink">
          {figures.waiting === 0 ? (
            "None"
          ) : (
            <Link href={orgHref(orgSlug, billsHref({ tab: "bills", review: "email" }))} className={LINK}>
              {count(figures.waiting, "file", "files")}
            </Link>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-ink-3">Added as bills in the last 30 days</dt>
        <dd className="font-semibold tabular-nums text-ink">{count(figures.added30d, "bill", "bills")}</dd>
      </div>
    </dl>
  );
}

/**
 * The Google Drive section of Settings (docs/superpowers/specs/2026-11-01-google-drive-intake-design.md GD2, GD4, GD5,
 * GD7, GD13, GD15, GD16), beside Google Sheets': which Google account's Drive is read, named by a masked email; the one
 * folder read, chosen by pasting its link, with when it was last read and what stopped a read; the figures; Check Google
 * Drive now for whoever adds the invoices it finds; Connect, Reconnect and Disconnect Google Drive for an owner or admin.
 * Every member sees the status. Headed by Google Drive's name in words beside a plain folder icon: no Google mark
 * without Google's permission (GD1). The choose and disconnect forms' answers are held here, not by their buttons, which
 * the revalidated page may move or drop in the same render: what Disconnect answered stays beside Connect Google Drive.
 */
export default function GoogleDrivePanel({
  orgSlug,
  view,
  canManage,
  canCheck,
  notice,
}: {
  orgSlug: string;
  view: GoogleDrivePanelView;
  /** Connecting, choosing the folder and disconnecting: an owner's or admin's (`integrations.manage`). */
  canManage: boolean;
  /** Check Google Drive now: whoever adds invoices (`records.write`). */
  canCheck: boolean;
  notice: string | null;
}) {
  const told = notice ? GOOGLE_DRIVE_NOTICES[notice] : undefined;
  const choose = useActionForm(chooseGoogleDriveFolderAction, CHOOSE_INITIAL, { resetOnSuccess: true });
  const disconnect = useActionForm(disconnectGoogleDriveAction, INITIAL);
  const answered = disconnect.state;
  return (
    <section aria-labelledby="googledrive-title" id="googledrive">
      <SectionHeader
        id="googledrive-title"
        className="items-center"
        title={
          <span className="inline-flex items-center gap-2">
            <Folder aria-hidden className="size-5 text-ink-2" />
            Google Drive
          </span>
        }
        action={<DocsLink href="/docs/guides/google-drive" topic="Google Drive" />}
      />
      <Card className="space-y-4 p-5">
        {told && (
          <p role="status" className={told.tone === "success" ? "text-sm text-ink" : "text-sm text-refused"}>
            {told.text}
          </p>
        )}
        {view.state === "not_set_up" ? (
          <p className="text-sm text-ink-2">Google Drive is not set up on this deployment yet.</p>
        ) : view.state === "not_connected" ? (
          <div className="max-w-prose space-y-3">
            <p className="text-sm text-ink-2">
              Bring bills in from a Google Drive folder. Each PDF added to the folder you choose is read into a bill that waits for review on Bills &amp;
              receivables, beside the invoices that came by email. A person adds every one: nothing is paid by itself.
            </p>
            {canManage ? <ConnectButton orgSlug={orgSlug} label="Connect Google Drive" /> : <p className="text-sm text-ink-3">An owner or admin can connect Google Drive.</p>}
          </div>
        ) : (
          <>
            {view.state === "connected" ? (
              <>
                <div className="max-w-prose space-y-1">
                  <p className="font-semibold text-ink">Connected to the Google Drive of {view.account}</p>
                  <p className="text-sm text-ink-2">Connected on {view.connectedAt}. Vestiarion reads only the folder chosen here, and writes nothing to the Drive.</p>
                </div>
                <div className="max-w-prose space-y-3 border-t border-line pt-4">
                  <h3 className="text-sm font-semibold text-ink">The folder</h3>
                  {view.folder ? (
                    <FolderShown folder={view.folder} />
                  ) : (
                    <p className="text-sm text-ink-2">
                      {canManage
                        ? "No folder is chosen yet. Choose a new, empty folder, or one whose bills are already paid: the files in it when you choose it are never read, only the ones added afterwards."
                        : "No folder is chosen yet. An owner or admin chooses the folder Vestiarion reads."}
                    </p>
                  )}
                  {canManage && <ChooseFolder orgSlug={orgSlug} form={choose} again={view.folder !== null} />}
                </div>
                <Figures orgSlug={orgSlug} figures={view.figures} />
              </>
            ) : view.state === "needs_reconnect" ? (
              <div className="max-w-prose space-y-1">
                <p className="font-semibold text-refused">Google Drive needs you to reconnect</p>
                <p className="text-sm text-ink-2">{view.words}</p>
              </div>
            ) : (
              <div className="max-w-prose space-y-1">
                <p className="font-semibold text-ink">Disconnected from {view.account}</p>
                <p className="text-sm text-ink-2">Files already read stay in the review list on Bills &amp; receivables. Nothing more is read from Google Drive.</p>
              </div>
            )}
            {canCheck && view.state === "connected" && view.folder && (
              <div className="border-t border-line pt-4">
                <GoogleDriveCheck orgSlug={orgSlug} />
              </div>
            )}
            {canManage ? (
              <div className="flex flex-wrap items-start gap-3 border-t border-line pt-4">
                {view.state === "needs_reconnect" && <ConnectButton orgSlug={orgSlug} label="Reconnect Google Drive" />}
                {view.state === "revoked" && <ConnectButton orgSlug={orgSlug} label="Connect Google Drive" />}
                {view.state !== "revoked" && (
                  <form {...disconnect.formProps}>
                    <input type="hidden" name="orgSlug" value={orgSlug} />
                    <SubmitButton variant="secondary" size="sm" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
                      Disconnect Google Drive
                    </SubmitButton>
                  </form>
                )}
                <FormMessage tone={answered.message && !answered.ok ? "error" : "neutral"} className="self-center">
                  {answered.message || null}
                </FormMessage>
              </div>
            ) : (
              <p className="text-sm text-ink-3">An owner or admin manages Google Drive.</p>
            )}
          </>
        )}
      </Card>
    </section>
  );
}
