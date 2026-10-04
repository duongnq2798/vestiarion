"use client";

import { AnimatePresence, m } from "motion/react";
import { Ban, BookOpen, KeyRound, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { createApiKeyAction, revokeApiKeyAction, type ApiKeyActionResult } from "@/app/actions/api-keys";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Checkbox } from "@/components/ui/Checkbox";
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
import { ManageDisclosure } from "@/components/vx/ManageDisclosure";
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
    <DialogContent title="Create an API key" description="A key reads this workspace's data, and can also add records if you allow it. It is shown once, right after you create it.">
      <form {...formProps} className="grid gap-5">
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <Field id="new-api-key-name" label="Name" description="1 to 60 characters.">
          <Input id="new-api-key-name" name="name" required maxLength={60} autoFocus autoComplete="off" placeholder="e.g. Reporting integration" />
        </Field>
        <Checkbox
          name="write"
          label="Can also add records"
          description="Counterparties, invoices, milestones and payee links. The agent still decides every payment, and an address added this way waits for a person to confirm it. A key never verifies work, approves or pays."
        />
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

function KeyCells({ apiKey }: { apiKey: ApiKeyRow }) {
  return (
    <>
      <TableCell className="max-w-[16rem] truncate">{apiKey.name}</TableCell>
      <TableCell className="whitespace-nowrap font-mono text-xs text-ink-2">{`vxk_${apiKey.prefix}_…`}</TableCell>
      <TableCell className="whitespace-nowrap text-ink-2">{apiKey.scopes.includes("write") ? "Read and write" : "Read only"}</TableCell>
      <TableCell className="whitespace-nowrap text-ink-2">{formatted(apiKey.createdAt)}</TableCell>
      <TableCell className="whitespace-nowrap text-ink-2">{formatted(apiKey.lastUsedAt)}</TableCell>
    </>
  );
}

function KeyHeads() {
  return (
    <>
      <TableHead>Name</TableHead>
      <TableHead>Key</TableHead>
      <TableHead>Access</TableHead>
      <TableHead>Created</TableHead>
      <TableHead>Last used</TableHead>
    </>
  );
}

/**
 * The keys that work, in a table; the revoked ones folded under it, closed, since nothing can be done with them but
 * read when they stopped (Settings structure design S4). A key revoked here leaves the table and joins the fold.
 */
export default function ApiKeysPanel({ orgSlug, apiKeys, canManage }: { orgSlug: string; apiKeys: ApiKeyRow[]; canManage: boolean }) {
  const active = apiKeys.filter((apiKey) => apiKey.revokedAt === null);
  const revoked = apiKeys.filter((apiKey) => apiKey.revokedAt !== null);
  return (
    <div className="space-y-8">
      <section aria-labelledby="api-keys-title">
        <SectionHeader
          id="api-keys-title"
          title="API keys"
          meta={revoked.length > 0 ? `${active.length} active, ${revoked.length} revoked` : `${active.length} in this workspace`}
          action={
            <div className="flex items-center gap-3">
              <Button asChild variant="link">
                <Link href="/docs/get-started/authentication" aria-label="Docs: API keys">
                  <BookOpen aria-hidden />
                  Docs
                </Link>
              </Button>
              {canManage && <CreateKeyDialog orgSlug={orgSlug} />}
            </div>
          }
        />
        {apiKeys.length === 0 ? (
          <EmptyState
            icon={<KeyRound />}
            title="No API keys yet"
            body={
              canManage
                ? "Create one to read this workspace's data, or to add records from your own system."
                : "An owner or admin can create one to read this workspace's data, or to add records."
            }
          />
        ) : (
          <Card className="overflow-hidden">
            {active.length === 0 ? (
              <p className="px-4 py-4 text-sm text-ink-2 sm:px-5">
                {canManage ? "No active keys. Create one to read this workspace's data, or to add records." : "No active keys."}
              </p>
            ) : (
              <Table className="min-w-[36rem]">
                <TableHeader>
                  <TableRow>
                    <KeyHeads />
                    {canManage && (
                      <TableHead>
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <AnimatePresence initial={false}>
                    {active.map((apiKey) => (
                      <m.tr key={apiKey.id} exit={{ opacity: 0 }} transition={EXIT}>
                        <KeyCells apiKey={apiKey} />
                        {canManage && (
                          <TableCell className="text-right">
                            <RevokeKeyForm orgSlug={orgSlug} apiKey={apiKey} />
                          </TableCell>
                        )}
                      </m.tr>
                    ))}
                  </AnimatePresence>
                </TableBody>
              </Table>
            )}
            {revoked.length > 0 && (
              <ManageDisclosure label={`Revoked keys (${revoked.length})`}>
                <Table className="min-w-[36rem]">
                  <TableHeader>
                    <TableRow>
                      <KeyHeads />
                      <TableHead>Revoked</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {revoked.map((apiKey) => (
                      <TableRow key={apiKey.id}>
                        <KeyCells apiKey={apiKey} />
                        <TableCell className="whitespace-nowrap text-ink-2">{formatted(apiKey.revokedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ManageDisclosure>
            )}
          </Card>
        )}
        {apiKeys.length > 0 && (
          <p className="mt-2 text-xs text-ink-3">
            {canManage
              ? "A key's full value is shown only once, when it is created. Lost one? Create a new key, then revoke the old one."
              : "A key's full value is shown only once, when it is created. Lost one? Ask an owner or admin for a new key."}
          </p>
        )}
      </section>
    </div>
  );
}
