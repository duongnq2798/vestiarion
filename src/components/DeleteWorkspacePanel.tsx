"use client";

import { CirclePause, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type ComponentProps } from "react";
import { pauseAgentAction, type AgentActionResult } from "@/app/actions/agent";
import { deleteWorkspaceAction, type DeleteWorkspaceActionResult } from "@/app/actions/workspace";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { DeletionContext } from "@/lib/platform/delete-workspace";

/**
 * The "Delete workspace" danger zone at the bottom of Settings
 * (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md §1, W1, W2).
 *
 * Owners only, and never for the founding workspace. The dialog says what is
 * deleted, and its delete button enables only once the workspace's slug is
 * typed exactly (and, for a live workspace, once its agent is paused). On
 * success the action redirects to /onboarding, so only a failure comes back.
 */
export interface DeleteWorkspacePanelProps {
  orgSlug: string;
  context: DeletionContext;
  canAdminister: boolean;
}

const INITIAL: DeleteWorkspaceActionResult = { ok: false, message: "" };

const mustPause = (context: DeletionContext) => context.live && !context.paused;

const PAUSE_INITIAL: AgentActionResult = { ok: false, message: "" };

/** The reason a pause from here gives, which every page shows while the agent is paused. */
export const PAUSE_REASON = "Before deleting this workspace";

/**
 * Pauses the agent from the danger zone itself, so an owner need not leave for the console (Settings structure design
 * S6). The page refreshes after a pause, and the note, with this form, goes away.
 */
function PauseForDeletion({ orgSlug }: { orgSlug: string }) {
  const { state, formProps } = useActionForm(pauseAgentAction, PAUSE_INITIAL, { toastOnSuccess: true });
  return (
    <form {...formProps} className="mt-3 flex flex-wrap items-center gap-3">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="reason" value={PAUSE_REASON} />
      <SubmitButton variant="secondary" size="sm" pendingLabel="Pausing…" icon={<CirclePause aria-hidden />}>
        Pause the agent
      </SubmitButton>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

/**
 * Why a running agent blocks the delete, and where to pause it. `offerPause` adds the pause button, for the workspace's
 * own danger zone; the account deletion dialog lists the note inside its own form, so it offers only the console.
 */
export function PauseFirstNote({ orgSlug, offerPause = false }: { orgSlug: string; offerPause?: boolean }) {
  return (
    <Callout tone="held" title="Pause the agent first, so no cycle runs while the workspace is deleted.">
      {offerPause ? "Pause it here or from the " : "Pause it from the "}
      <Link href={`/o/${orgSlug}/console`} className="font-medium text-agent underline-offset-4 hover:underline">
        console
      </Link>
      ; the workspace can be deleted once it is paused.
      {offerPause && <PauseForDeletion orgSlug={orgSlug} />}
    </Callout>
  );
}

/** Where a deleted workspace's wallets stay (W2). Shown only when it has any. */
export function WalletSentence({ hosted }: { hosted: boolean }) {
  return hosted
    ? "Its wallets stay in the Circle account that holds them, Vestiarion's testnet account, with any USDC in them; this workspace can no longer reach them."
    : "Its wallets stay in the Circle account that holds them, with any USDC in them; Vestiarion can no longer reach them.";
}

/** What deleting the workspace takes with it, and what stays (W2). */
export function DeleteWorkspaceConsequences({ slug, walletCount, hosted }: { slug: string; walletCount: number; hosted: boolean }) {
  return (
    <>
      <span className="block">
        Deleting <span className="break-all font-mono text-ink">{slug}</span> removes its invoices, counterparties, milestones, treasury records, the ledger, API
        keys, webhooks, members and invitations, for everyone in it. This cannot be undone.
      </span>
      {walletCount > 0 && (
        <span className="mt-2 block">
          <WalletSentence hosted={hosted} />
        </span>
      )}
      <span className="mt-2 block">Vestiarion keeps only a record that the workspace existed: its name, and its ledger&apos;s length and last hash.</span>
    </>
  );
}

/**
 * How the dialog may be dismissed: never by a click outside (as ConfirmDialog),
 * and not by Escape while the delete is on its way.
 */
export function dismissGuards(pending: boolean) {
  return {
    onInteractOutside: (event: { preventDefault(): void }) => event.preventDefault(),
    onEscapeKeyDown: (event: { preventDefault(): void }) => {
      if (pending) event.preventDefault();
    },
  };
}

export interface DeleteWorkspaceFormProps {
  orgSlug: string;
  context: DeletionContext;
  /** The action's state lives in the dialog, which also needs `pending` to stay open. */
  pending: boolean;
  message: string;
  formProps: ComponentProps<"form">;
}

/** The confirmation inside the dialog: type the slug, then delete. */
export function DeleteWorkspaceForm({ orgSlug, context, pending, message, formProps }: DeleteWorkspaceFormProps) {
  const [typed, setTyped] = useState("");
  const blocked = mustPause(context);
  return (
    <div className="grid gap-4">
      {/* Beside the form, not in it: the note holds a form of its own, to pause the agent. */}
      {blocked && <PauseFirstNote orgSlug={orgSlug} offerPause />}
      <form {...formProps} className="grid gap-4">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <Field
          id="delete-workspace-confirm"
          label={
            <>
              Type <span className="break-all font-mono">{context.slug}</span> to confirm
            </>
          }
        >
          <Input
            name="confirmSlug"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            className="font-mono"
          />
        </Field>
        <FormMessage tone={message ? "error" : "neutral"}>{message || null}</FormMessage>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" variant="danger-solid" icon={<Trash2 />} disabled={typed !== context.slug || blocked} loading={pending}>
            Delete this workspace
          </Button>
        </DialogFooter>
      </form>
    </div>
  );
}

/**
 * The dialog holds the action's state, so it can refuse to close while the
 * delete is pending. `alertdialog`, as ConfirmDialog is: it interrupts to ask
 * before something that cannot be taken back.
 */
function DeleteWorkspaceDialog({ orgSlug, context }: { orgSlug: string; context: DeletionContext }) {
  const { state, pending, formProps } = useActionForm(deleteWorkspaceAction, INITIAL);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="danger" icon={<Trash2 />}>
          Delete workspace
        </Button>
      </DialogTrigger>
      <DialogContent
        role="alertdialog"
        title="Delete this workspace?"
        description={<DeleteWorkspaceConsequences slug={context.slug} walletCount={context.walletCount} hosted={context.hosted} />}
        showClose={!pending}
        {...dismissGuards(pending)}
      >
        <DeleteWorkspaceForm
          orgSlug={orgSlug}
          context={context}
          pending={pending}
          message={state.ok ? "" : state.message}
          formProps={formProps}
        />
      </DialogContent>
    </Dialog>
  );
}

export default function DeleteWorkspacePanel({ orgSlug, context, canAdminister }: DeleteWorkspacePanelProps) {
  if (!canAdminister || context.isFounding) return null;
  return (
    <section aria-labelledby="delete-workspace-title">
      <SectionHeader id="delete-workspace-title" title="Delete workspace" />
      <div className="space-y-4 rounded-xl border border-refused-line p-5">
        <p className="text-sm leading-relaxed text-ink-2">
          Deletes this workspace and everything in it, for every member. Only an owner can do this, and it cannot be undone.
        </p>
        {mustPause(context) && <PauseFirstNote orgSlug={orgSlug} offerPause />}
        <DeleteWorkspaceDialog orgSlug={orgSlug} context={context} />
      </div>
    </section>
  );
}
