"use client";

import { setDocumentRequestsAction, type DocumentRequestsActionResult } from "@/app/actions/document-requests";
import { DocsLink } from "@/components/DocsLink";
import { Card } from "@/components/ui/Card";
import { FormMessage } from "@/components/ui/FormMessage";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";
import type { DocumentRequestsSetting } from "@/lib/document-requests/rules";

/**
 * The "Ask vendors for missing documents" section of Settings, beside the payee lock
 * (docs/superpowers/specs/2026-10-23-document-requests-design.md ER1): off, shadow or on. Everyone sees it; an owner
 * (`canChange`) changes it. Before the workspace's database has it (`ready`), the section says so and offers nothing.
 */
export interface DocumentRequestsPanelProps {
  orgSlug: string;
  status: { setting: DocumentRequestsSetting; ready: boolean };
  canChange: boolean;
}

const INITIAL: DocumentRequestsActionResult = { ok: false, message: "" };
const save = withSuccessToast(setDocumentRequestsAction);

/** What the setting does now, in one sentence. */
export function documentRequestsSentence(setting: DocumentRequestsSetting): string {
  if (setting === "shadow") return "Shadow: each waiting bill's card says what Vestiarion would ask its vendor, and nothing is sent.";
  if (setting === "on") return "On: when a bill waits for its purchase order or goods receipt, Vestiarion emails the vendor's billing address a link to send it.";
  return "Off: Vestiarion does not ask vendors for missing documents.";
}

const CHOICES: Array<{ value: DocumentRequestsSetting; label: string; description: string }> = [
  { value: "off", label: "Off", description: "Nothing is asked. You chase vendors yourself, and add the details on the bill." },
  { value: "shadow", label: "Shadow", description: "See which vendors Vestiarion would ask, and for what, on each bill's card, before anything is sent." },
  { value: "on", label: "On", description: "Vestiarion emails the vendor once per bill, at most 20 a day. The link works for 14 days." },
];

function ChangeForm({ orgSlug, setting }: { orgSlug: string; setting: DocumentRequestsSetting }) {
  const { state, formProps } = useActionForm(save, INITIAL);
  return (
    <form {...formProps} className="grid gap-4">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <RadioGroup name="setting" legend="Vendor requests" defaultValue={setting} options={CHOICES} />
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </div>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>{state.ok ? null : state.message}</FormMessage>
    </form>
  );
}

export default function DocumentRequestsPanel({ orgSlug, status, canChange }: DocumentRequestsPanelProps) {
  return (
    <section aria-labelledby="document-requests-title">
      <SectionHeader
        id="document-requests-title"
        title="Ask vendors for missing documents"
        action={<DocsLink href="/docs/guides/first-payment#ask-the-vendor-for-a-missing-document" topic="asking vendors for missing documents" />}
      />
      <Card className="space-y-4 p-5">
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{status.ready ? documentRequestsSentence(status.setting) : "Not available in this workspace yet."}</p>
          <p className="text-sm text-ink-2">
            A bill missing its purchase order or goods receipt waits for you. The vendor has the document: a one-time link lets them send it straight to
            the bill, without an account. You still add the details, and the agent decides the bill again. Nothing is paid because a document arrived.
          </p>
        </div>
        {status.ready && (
          <div className="border-t border-line pt-4">
            {canChange ? <ChangeForm orgSlug={orgSlug} setting={status.setting} /> : <p className="text-sm text-ink-2">An owner of this workspace can change it.</p>}
          </div>
        )}
      </Card>
    </section>
  );
}
