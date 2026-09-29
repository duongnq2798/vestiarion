"use client";

import { AnimatePresence, m } from "motion/react";
import { Ban, KeyRound, Plus } from "lucide-react";
import { useState } from "react";
import { createApiKeyAction, revokeApiKeyAction, type ApiKeyActionResult } from "@/app/actions/api-keys";
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
import type { ApiKeyRow } from "@/lib/platform/api-keys";

const INITIAL: ApiKeyActionResult = { ok: false, message: "" };
const EXIT = { duration: MOTION.duration.exit, ease: MOTION.ease.exit };

const dateFormat = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function formatted(iso: string | null): string {
  return iso ? dateFormat.format(new Date(iso)) : "never";
}

function RowError({ state }: { state: ApiKeyActionResult }) {
  if (state.ok || !state.message) return null;
  return (
    <p role="alert" className="text-xs text-refused">
      {state.message}
    </p>
  );
}

/**
 * "Create key" opens a fresh instance of this form every time — keyed by
 * `formKey` in the dialog around it — so a token shown after one creation
 * never lingers into the next. The dialog stays open on success (its close
 * control is hidden) until the person presses "Done", having copied the key.
 */
function CreateKeyForm({ orgSlug, onDone }: { orgSlug: string; onDone: () => void }) {
  const { state, formProps } = useActionForm(createApiKeyAction, INITIAL);
  const created = state.ok && state.token;

  if (created) {
    return (
      <DialogContent title="API key created" showClose={false}>
        <div className="space-y-4">
          <Field id="new-api-key-token" label="Copy this key now. It will not be shown again.">
            <div className="flex items-center gap-2">
              <Input
                id="new-api-key-token"
                readOnly
                value={state.token}
                onFocus={(event) => event.currentTarget.select()}
                className="font-mono text-xs"
              />
              <CopyButton value={state.token!} label="Copy the API key" variant="secondary" />
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
    <DialogContent title="Create an API key" description="A read-only key for this workspace's data. It is shown once, right after you create it.">
      <form {...formProps} className="grid gap-5">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <Field id="new-api-key-name" label="Name" description="1 to 60 characters.">
          <Input id="new-api-key-name" name="name" required maxLength={60} autoFocus autoComplete="off" placeholder="e.g. Reporting integration" />
        </Field>
        <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <SubmitButton pendingLabel="Creating…">Create key</SubmitButton>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

function CreateKeyDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // A closed dialog's next open starts from a blank form, not from whatever key the last creation showed.
        if (!next) setFormKey((count) => count + 1);
      }}
    >
      <DialogTrigger asChild>
        <Button icon={<Plus />}>Create key</Button>
      </DialogTrigger>
      <CreateKeyForm key={formKey} orgSlug={orgSlug} onDone={() => setOpen(false)} />
    </Dialog>
  );
}

function RevokeKeyForm({ orgSlug, apiKey }: { orgSlug: string; apiKey: ApiKeyRow }) {
  const formId = `revoke-key-${apiKey.id}`;
  const { state, pending, formProps } = useActionForm(revokeApiKeyAction, INITIAL, { toastOnSuccess: true });

  return (
    <form id={formId} {...formProps} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="keyId" value={apiKey.id} />
      <ConfirmDialog
        formId={formId}
        trigger={
          <Button variant="danger" size="sm" icon={<Ban />} loading={pending}>
            Revoke
          </Button>
        }
        title={`Revoke "${apiKey.name}"?`}
        description="Anything using this key stops working at once. This cannot be undone."
        confirmLabel="Revoke key"
      />
      <RowError state={state} />
    </form>
  );
}

export default function ApiKeysPanel({ orgSlug, apiKeys, canManage }: { orgSlug: string; apiKeys: ApiKeyRow[]; canManage: boolean }) {
  return (
    <div className="space-y-8">
      <section aria-labelledby="api-keys-title">
        <SectionHeader
          id="api-keys-title"
          title="API keys"
          meta={`${apiKeys.length} in this workspace`}
          action={canManage ? <CreateKeyDialog orgSlug={orgSlug} /> : undefined}
        />
        {apiKeys.length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title="No API keys yet"
            body={canManage ? "Create one for read-only access to this workspace's data." : "An owner or admin can create one for read-only access to this workspace's data."}
          />
        ) : (
          <Card className="overflow-hidden">
            <Table className="min-w-[40rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  {canManage && (
                    <TableHead>
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                <AnimatePresence initial={false}>
                  {apiKeys.map((apiKey) => {
                    const revoked = apiKey.revokedAt !== null;
                    return (
                      <m.tr key={apiKey.id} exit={{ opacity: 0 }} transition={EXIT}>
                        <TableCell className="max-w-[16rem] truncate">{apiKey.name}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-ink-2">{`vxk_${apiKey.prefix}_…`}</TableCell>
                        <TableCell className="whitespace-nowrap text-ink-2">{formatted(apiKey.createdAt)}</TableCell>
                        <TableCell className="whitespace-nowrap text-ink-2">{formatted(apiKey.lastUsedAt)}</TableCell>
                        <TableCell>
                          <Badge tone={revoked ? "refused" : "proof"} size="sm" dot>
                            {revoked ? "Revoked" : "Active"}
                          </Badge>
                        </TableCell>
                        {canManage && <TableCell className="text-right">{!revoked && <RevokeKeyForm orgSlug={orgSlug} apiKey={apiKey} />}</TableCell>}
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
