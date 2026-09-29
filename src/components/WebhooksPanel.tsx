"use client";

import { AnimatePresence, m } from "motion/react";
import { Plus, Send, Trash2, Webhook } from "lucide-react";
import { useState } from "react";
import { createWebhookEndpointAction, removeWebhookEndpointAction, sendTestWebhookAction, type WebhookActionResult } from "@/app/actions/webhooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { MOTION } from "@/components/ui/tokens";
import { useActionForm } from "@/components/ui/useActionForm";
import type { WebhookEndpointView } from "@/lib/platform/webhooks";

const INITIAL: WebhookActionResult = { ok: false, message: "" };
const EXIT = { duration: MOTION.duration.exit, ease: MOTION.ease.exit };

const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function formatted(iso: string | null): string {
  return iso ? dateFormat.format(new Date(iso)) : "never";
}

function RowError({ state }: { state: WebhookActionResult }) {
  if (state.ok || !state.message) return null;
  return (
    <p role="alert" className="text-xs text-refused">
      {state.message}
    </p>
  );
}

/**
 * "Add endpoint" opens a fresh instance of this form every time — keyed by
 * `formKey` in the dialog around it — so a secret shown after one creation
 * never lingers into the next. The dialog stays open on success (its close
 * control is hidden) until the person presses "Done", having copied the
 * secret.
 */
function AddEndpointForm({ orgSlug, onDone }: { orgSlug: string; onDone: () => void }) {
  const { state, formProps } = useActionForm(createWebhookEndpointAction, INITIAL);
  const created = state.ok && state.secret;

  if (created) {
    return (
      <DialogContent title="Webhook endpoint added" showClose={false}>
        <div className="space-y-4">
          <Field id="new-webhook-secret" label="Copy this signing secret now. It will not be shown again.">
            <div className="flex items-center gap-2">
              <Input
                id="new-webhook-secret"
                readOnly
                value={state.secret}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-xs"
              />
              <CopyButton value={state.secret!} label="Copy the signing secret" variant="secondary" />
            </div>
          </Field>
          <DialogFooter>
            <Button onClick={onDone}>Done</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent
      title="Add a webhook endpoint"
      description="An HTTPS URL that receives this workspace's ledger entries, signed. Its signing secret is shown once, right after it is created."
    >
      <form {...formProps} className="grid gap-5">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <Field id="new-webhook-url" label="URL">
          <Input id="new-webhook-url" name="url" type="url" required autoFocus autoComplete="off" placeholder="https://example.com/webhooks/vestiarion" />
        </Field>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <SubmitButton pendingLabel="Adding…">Add endpoint</SubmitButton>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function AddEndpointDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A closed dialog's next open starts from a blank form, not from whatever secret the last creation showed.
        if (!next) setFormKey((count) => count + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button icon={<Plus />}>Add endpoint</Button>
      </DialogTrigger>
      <AddEndpointForm key={formKey} orgSlug={orgSlug} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function SendTestForm({ orgSlug, endpoint }: { orgSlug: string; endpoint: WebhookEndpointView }) {
  const formId = `send-test-webhook-${endpoint.id}`;
  // A failed test says only that it was not delivered, and why — the same
  // reason a real delivery would have failed with, from `sendTestEvent`.
  const { state, pending, formProps } = useActionForm(sendTestWebhookAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="endpointId" value={endpoint.id} />
      <Button type="submit" variant="secondary" size="sm" icon={<Send />} loading={pending}>
        Send test
      </Button>
      <RowError state={state} />
    </form>
  );
}

function RemoveEndpointForm({ orgSlug, endpoint }: { orgSlug: string; endpoint: WebhookEndpointView }) {
  const formId = `remove-webhook-${endpoint.id}`;
  const { state, pending, formProps } = useActionForm(removeWebhookEndpointAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="endpointId" value={endpoint.id} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<Trash2 />} loading={pending}>
            Remove
          </Button>
        }
        title={`Remove the endpoint at ${endpoint.host}?`}
        description="Its queued deliveries stop, and it will no longer receive events. This cannot be undone — adding it back means a fresh endpoint, with a fresh secret."
        confirmLabel="Remove endpoint"
      />
      <RowError state={state} />
    </form>
  );
}

export default function WebhooksPanel({ orgSlug, endpoints, canManage }: { orgSlug: string; endpoints: WebhookEndpointView[]; canManage: boolean }) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="webhooks-title">
        <SectionHeader
          id="webhooks-title"
          title="Webhooks"
          meta={`${endpoints.length} in this workspace`}
          action={canManage ? <AddEndpointDialog orgSlug={orgSlug} /> : undefined}
        />
        {endpoints.length === 0 ? (
          <EmptyState
            icon={<Webhook />}
            title="No webhook endpoints yet"
            body={
              canManage
                ? "Add one to receive this workspace's ledger entries, signed, as they happen."
                : "An owner or admin can add one to receive this workspace's ledger entries, signed, as they happen."
            }
          />
        ) : (
          <Card className="overflow-hidden">
            <Table className="min-w-[48rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>{canManage ? "URL" : "Host"}</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last success</TableHead>
                  <TableHead>Last failure</TableHead>
                  <TableHead>Failures</TableHead>
                  {canManage && (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                <AnimatePresence initial={false}>
                  {endpoints.map((endpoint) => {
                    const disabled = endpoint.disabledAt !== null;
                    return (
                      <m.tr key={endpoint.id} exit={{ opacity: 0 }} transition={EXIT}>
                        {/* `endpoint.url` is present at all only for a manager (built server-side, `toWebhookEndpointViews`); it may name a customer's own host, so everyone else falls back to the bare host. */}
                        <TableCell className="max-w-[20rem] truncate font-mono text-xs text-ink-2">{endpoint.url ?? endpoint.host}</TableCell>
                        <TableCell>
                          <Badge tone={disabled ? "refused" : "proof"} size="sm" dot>
                            {disabled ? "Disabled after failures" : "Active"}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-ink-2">{formatted(endpoint.lastSuccessAt)}</TableCell>
                        <TableCell className="whitespace-nowrap text-ink-2">{formatted(endpoint.lastFailureAt)}</TableCell>
                        <TableCell className="whitespace-nowrap text-ink-2">{endpoint.consecutiveFailures}</TableCell>
                        {canManage && (
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-2">
                              <SendTestForm orgSlug={orgSlug} endpoint={endpoint} />
                              <RemoveEndpointForm orgSlug={orgSlug} endpoint={endpoint} />
                            </div>
                          </TableCell>
                        )}
                      </m.tr>
                    );
                  })}
                </AnimatePresence>
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
