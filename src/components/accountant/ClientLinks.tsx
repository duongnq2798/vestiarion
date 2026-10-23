"use client";

import { Link2, X } from "lucide-react";
import { createClientLinkAction, revokeClientLinkAction, type ClientLinkActionResult } from "@/app/accountant/actions";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import type { ClientLink, ClientLinkState } from "@/lib/platform/client-links";

/**
 * "Invite a client" on the accountant console (docs/superpowers/specs/2026-10-23-accountant-client-links-design.md AC1):
 * make a one-time link, bound to the client's address when one is given, shown once with a copy button; then the
 * accountant's links, each open, used (with the workspace's name while they are still in it), expired or revoked, with
 * Revoke on an open one. Before migration 0143 runs, it says the feature is not available yet.
 */

const INITIAL: ClientLinkActionResult = { ok: false, message: "" };

export const INVITE_CLIENT_TITLE = "Invite a client";
export const INVITE_CLIENT_INTRO =
  "Send a client one link. They sign in, name their workspace, and it opens on Arc testnet in shadow mode, with you in it as its accountant. A link works once, for 7 days; give the client's email and it works only for that address.";
export const ANYONE_WITH_THE_LINK = "Anyone signed in with the link";

const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const day = (iso: string) => dateFormat.format(new Date(iso));

const STATE: Record<ClientLinkState, { label: string; tone: "agent" | "proof" | "neutral" }> = {
  open: { label: "Open", tone: "agent" },
  used: { label: "Used", tone: "proof" },
  expired: { label: "Expired", tone: "neutral" },
  revoked: { label: "Revoked", tone: "neutral" },
};

/** What a link's row says beside its state. */
export function clientLinkDetail(link: ClientLink): string {
  switch (link.state) {
    case "open":
      return `Expires ${day(link.expiresAt)}`;
    case "used":
      return link.workspace ? `Opened ${link.workspace}` : `Used ${day(link.usedAt ?? link.createdAt)}`;
    case "expired":
      return `Expired ${day(link.expiresAt)}`;
    case "revoked":
      return `Made ${day(link.createdAt)}`;
  }
}

function CreateLinkForm() {
  const { state, formProps } = useActionForm(createClientLinkAction, INITIAL, { resetOnSuccess: true });
  return (
    <Card asChild className="space-y-3 p-4 sm:p-5">
      <form {...formProps}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="client-link-email" label="Client's email (optional)" className="min-w-0 flex-1">
            <Input name="email" type="email" autoComplete="off" placeholder="owner@client.com" />
          </Field>
          <SubmitButton icon={<Link2 />} pendingLabel="Making…" className="shrink-0">
            Create link
          </SubmitButton>
        </div>
        <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
        {state.ok && state.link && (
          <div className="rounded-xl border border-agent-line bg-agent-soft p-3">
            <p className="text-xs font-medium text-agent">{state.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <Input readOnly value={state.link} size="sm" aria-label="Client invite link" onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
              <CopyButton value={state.link} variant="secondary">
                Copy link
              </CopyButton>
            </div>
          </div>
        )}
      </form>
    </Card>
  );
}

function LinkRow({ link }: { link: ClientLink }) {
  const formId = `revoke-client-link-${link.id}`;
  const { state, pending, formProps } = useActionForm(revokeClientLinkAction, INITIAL, { toastOnSuccess: true });
  const who = link.email ?? ANYONE_WITH_THE_LINK;
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate text-sm text-ink">{who}</p>
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <Badge tone={STATE[link.state].tone} size="sm">
            {STATE[link.state].label}
          </Badge>
          {clientLinkDetail(link)}
        </p>
        {!state.ok && state.message && (
          <p role="alert" className="text-xs text-refused">
            {state.message}
          </p>
        )}
      </div>
      {link.state === "open" && (
        <form id={formId} {...formProps}>
          <input type="hidden" name="linkId" value={link.id} />
          <ConfirmDialog
            formId={formId}
            trigger={
              <Button variant="danger" size="sm" icon={<X />} loading={pending}>
                Revoke
              </Button>
            }
            title={link.email ? `Revoke the link for ${link.email}?` : "Revoke this link?"}
            description="The link stops working at once. You can make a new one later."
            confirmLabel="Revoke link"
          />
        </form>
      )}
    </li>
  );
}

export function ClientLinks({ available, links }: { available: boolean; links: ClientLink[] }) {
  return (
    <section aria-labelledby="invite-client-title" className="space-y-3">
      <SectionHeader id="invite-client-title" title={INVITE_CLIENT_TITLE} meta={available ? "the link is shown once, right after you make it" : undefined} />
      <p className="max-w-2xl text-sm text-ink-2">{INVITE_CLIENT_INTRO}</p>
      {available ? <CreateLinkForm /> : <p className="text-sm text-ink-3">Client invite links are not available yet.</p>}
      {links.length > 0 && (
        <Card className="overflow-hidden">
          <ul aria-label="Your client links" className="divide-y divide-line">
            {links.map((link) => (
              <LinkRow key={link.id} link={link} />
            ))}
          </ul>
        </Card>
      )}
    </section>
  );
}
