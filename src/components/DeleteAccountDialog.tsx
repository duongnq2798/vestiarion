"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { accountDeletionPlanAction, deleteAccountAction, type AccountDeletionPlanResult, type DeleteAccountActionResult } from "@/app/account/actions";
import { dismissGuards, PauseFirstNote, WalletSentence } from "@/components/DeleteWorkspacePanel";
import { Button } from "@/components/ui/Button";
import { Callout } from "@/components/ui/Callout";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { useActionForm } from "@/components/ui/useActionForm";
import type { AccountDeletionPlan, BlockedReason } from "@/lib/platform/delete-account";
import { DELETE_ACCOUNT_CONFIRMATION } from "@/lib/platform/delete-account-phrase";

/**
 * Deleting your own account (docs/superpowers/specs/2026-09-30-workspace-delete-footer-screenshots-design.md §6).
 *
 * The dialog reads what would happen (`accountDeletionPlanAction`) each time
 * it opens, rather than being handed it by the page: the account menu is on
 * every workspace page, and the plan costs a read per workspace the person
 * owns, which only the few who open the dialog should pay. Reading it on open
 * also means it is never stale by the time it is shown.
 */

const INITIAL: DeleteAccountActionResult = { ok: false, message: "" };

const REASONS: Record<BlockedReason, string> = {
  has_other_members: "You are its last owner, and it has other members. Make someone else an owner, or delete the workspace, first.",
  founding: "You are the last owner of the founding workspace, which cannot be deleted. Make someone else an owner first.",
};

const BLOCKED_LINK: Record<BlockedReason, { path: string; label: string }> = {
  has_other_members: { path: "members", label: "Open its Members page" },
  founding: { path: "settings", label: "Open its Settings" },
};

const linkClass = "font-medium text-agent underline-offset-4 hover:underline";

function Blocked({ blocked }: { blocked: AccountDeletionPlan["blocked"] }) {
  return (
    <Callout tone="refused" title="Your account cannot be deleted yet">
      <ul className="mt-1 space-y-3">
        {blocked.map((workspace) => (
          <li key={workspace.slug} className="space-y-0.5">
            <p className="font-medium text-ink">
              {workspace.name} <span className="break-all font-mono text-xs text-ink-3">{workspace.slug}</span>
            </p>
            <p>{REASONS[workspace.reason]}</p>
            {/* Someone else is made an owner on the Members page; the founding workspace's Settings are where it lives. */}
            <Link href={`/o/${workspace.slug}/${BLOCKED_LINK[workspace.reason].path}`} className={linkClass}>
              {BLOCKED_LINK[workspace.reason].label}
            </Link>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function SoleWorkspaces({ workspaces }: { workspaces: AccountDeletionPlan["soleWorkspaces"] }) {
  if (workspaces.length === 0) return <p className="text-sm text-ink-2">No workspace is deleted with your account.</p>;
  return (
    <section aria-labelledby="delete-account-sole" className="space-y-2">
      <h3 id="delete-account-sole" className="text-sm font-semibold text-ink">
        Deleted with your account
      </h3>
      <p className="text-sm leading-relaxed text-ink-2">
        You are the only member of these workspaces. Each is deleted with everything in it (invoices, counterparties, milestones, treasury records, the ledger,
        API keys and webhooks), and Vestiarion keeps only a record that it existed.
      </p>
      <ul className="space-y-3">
        {workspaces.map((workspace) => (
          <li key={workspace.slug} className="space-y-2 rounded-xl border border-line p-3 text-sm">
            <p className="font-medium text-ink">
              {workspace.name} <span className="break-all font-mono text-xs text-ink-3">{workspace.slug}</span>
            </p>
            {workspace.walletCount > 0 && (
              <p className="leading-relaxed text-ink-2">
                <WalletSentence hosted={workspace.hosted} />
              </p>
            )}
            {workspace.live && !workspace.paused && <PauseFirstNote orgSlug={workspace.slug} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface DeleteAccountBodyProps {
  plan: AccountDeletionPlan;
  /** The action's state lives in the dialog, which also needs `pending` to stay open. */
  pending: boolean;
  message: string;
  formProps: ComponentProps<"form">;
}

/** What deleting the account does, and the confirmation. Nothing to confirm while a workspace blocks it. */
export function DeleteAccountBody({ plan, pending, message, formProps }: DeleteAccountBodyProps) {
  const [typed, setTyped] = useState("");
  const blocked = plan.blocked.length > 0;
  const mustPause = plan.soleWorkspaces.some((workspace) => workspace.live && !workspace.paused);
  const remains = (
    <p className="text-sm leading-relaxed text-ink-2">
      Records you added in workspaces you share stay, without your name attached. Your memberships and the invitations you sent are removed. API
      keys you created stop working. A workspace&apos;s signed ledger is append-only, so entries you caused keep your account&apos;s id (never your
      email).
    </p>
  );

  if (blocked) {
    return (
      <div className="grid gap-4">
        <Blocked blocked={plan.blocked} />
        {remains}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form {...formProps} className="grid gap-4">
      <SoleWorkspaces workspaces={plan.soleWorkspaces} />
      {remains}
      <Field
        id="delete-account-confirm"
        label={
          <>
            Type <span className="font-mono">{DELETE_ACCOUNT_CONFIRMATION}</span> to confirm
          </>
        }
      >
        <Input
          name="confirmText"
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
        <Button type="submit" variant="danger-solid" icon={<Trash2 />} disabled={typed !== DELETE_ACCOUNT_CONFIRMATION || mustPause} loading={pending}>
          Delete my account
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Reads the plan once per opening: the dialog's content mounts each time it opens. */
function PlanLoader({ children }: { children: (plan: AccountDeletionPlan) => ReactNode }) {
  const [result, setResult] = useState<AccountDeletionPlanResult | null>(null);
  useEffect(() => {
    let current = true;
    accountDeletionPlanAction().then(
      (answer) => current && setResult(answer),
      () => current && setResult({ ok: false, message: "Your workspaces could not be read; try again." })
    );
    return () => {
      current = false;
    };
  }, []);
  if (!result) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-2">
        <Spinner /> Checking your workspaces…
      </p>
    );
  }
  if (!result.ok) {
    return (
      <Callout tone="refused" role="alert">
        {result.message}
      </Callout>
    );
  }
  return children(result.plan);
}

export interface DeleteAccountDialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The control that opens it, when the dialog has one of its own. */
  trigger?: ReactElement;
}

/**
 * An `alertdialog`, as the workspace one: it interrupts to ask before
 * something that cannot be taken back. Never closed by a click outside, and
 * not by Escape or Cancel while the deletion is on its way.
 */
export function DeleteAccountDialog({ open, onOpenChange, trigger }: DeleteAccountDialogProps) {
  const { state, pending, formProps } = useActionForm(deleteAccountAction, INITIAL);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        role="alertdialog"
        title="Delete your account?"
        description="This cannot be undone."
        showClose={!pending}
        {...dismissGuards(pending)}
      >
        <PlanLoader>
          {(plan) => <DeleteAccountBody plan={plan} pending={pending} message={state.ok ? "" : state.message} formProps={formProps} />}
        </PlanLoader>
      </DialogContent>
    </Dialog>
  );
}

/** For pages without the account menu (/onboarding): a button beside Sign out. */
export function DeleteAccountButton() {
  return (
    <DeleteAccountDialog
      trigger={
        <Button variant="ghost" icon={<Trash2 />} className="text-refused hover:text-refused">
          Delete account
        </Button>
      }
    />
  );
}
