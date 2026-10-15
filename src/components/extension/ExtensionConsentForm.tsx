"use client";

import { Check, X } from "lucide-react";
import { useEffect } from "react";
import { allowExtensionAction, type ExtensionConsentResult } from "@/app/actions/extension";
import { Button } from "@/components/ui/Button";
import { FormMessage } from "@/components/ui/FormMessage";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";

const INITIAL: ExtensionConsentResult = { ok: false, message: "" };

/** What the extension can do once connected, as the consent page says it (invoice capture design C13). */
export const EXTENSION_CAN = [
  "Send invoice text you select, or a file you choose, to this workspace to be read.",
  "Create drafts here, and read and change the drafts it created until you send them.",
] as const;

/** What it can never do. */
export const EXTENSION_CANNOT = [
  "Add a bill, approve or pay anything, or touch a wallet.",
  "See your bills, counterparties, members, wallets, API keys or anything else in the workspace.",
  "Read a page unless you press Capture in it.",
] as const;

/**
 * Allow and Cancel on /extension/authorize (invoice capture design C13): the workspace to connect, then the code goes
 * back to the extension's own address. The request's fields travel as hidden inputs and are checked again by the
 * action; the session says who.
 */
export function ExtensionConsentForm({
  workspaces,
  clientId,
  redirectUri,
  codeChallenge,
  state,
  scope,
  cancelHref,
}: {
  workspaces: Array<{ slug: string; name: string; role: string }>;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope: string;
  cancelHref: string;
}) {
  const { state: result, formProps } = useActionForm(allowExtensionAction, INITIAL);
  useEffect(() => {
    if (result.ok && result.redirectTo) window.location.assign(result.redirectTo);
  }, [result]);

  return (
    <form {...formProps} className="space-y-6">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="redirectUri" value={redirectUri} />
      <input type="hidden" name="codeChallenge" value={codeChallenge} />
      <input type="hidden" name="state" value={state} />
      <input type="hidden" name="scope" value={scope} />
      {workspaces.length === 1 ? (
        <input type="hidden" name="orgSlug" value={workspaces[0].slug} />
      ) : (
        <RadioGroup
          name="orgSlug"
          legend="Workspace to send drafts to"
          defaultValue={workspaces[0]?.slug}
          required
          options={workspaces.map((workspace) => ({ value: workspace.slug, label: workspace.name, description: `You are ${workspace.role === "owner" ? "an owner" : "an admin"} here.` }))}
        />
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-sm font-semibold text-ink">It can</p>
          <ul className="mt-2 space-y-2 text-sm text-ink-2">
            {EXTENSION_CAN.map((line) => (
              <li key={line} className="flex gap-2">
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-sm font-semibold text-ink">It cannot</p>
          <ul className="mt-2 space-y-2 text-sm text-ink-2">
            {EXTENSION_CANNOT.map((line) => (
              <li key={line} className="flex gap-2">
                <X aria-hidden className="mt-0.5 size-4 shrink-0 text-refused" />
                {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-sm text-ink-3">A draft becomes a bill only when an owner or admin adds it on Bills &amp; receivables. Disconnect it in the extension or in Settings at any time.</p>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Connecting…" icon={<Check aria-hidden />} disabled={result.ok}>
          Allow
        </SubmitButton>
        <Button asChild variant="secondary">
          <a href={cancelHref}>Cancel</a>
        </Button>
      </div>
      <FormMessage tone={result.ok ? "success" : result.message ? "error" : "neutral"}>{result.message || null}</FormMessage>
    </form>
  );
}
