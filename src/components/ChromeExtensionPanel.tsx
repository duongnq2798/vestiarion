"use client";

import { Unplug } from "lucide-react";
import Link from "next/link";
import { disconnectExtensionAction, type ExtensionActionResult } from "@/app/actions/extension";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

const INITIAL: ExtensionActionResult = { ok: false, message: "" };
/**
 * A row's Disconnect answers with a toast the action raises itself: the revalidated page drops the row in the same
 * render (docs/superpowers/specs/2026-10-27-disconnect-confirmation-design.md DC1).
 */
const disconnect = withSuccessToast(disconnectExtensionAction);

export interface ConnectionView {
  id: string;
  /** Who connected it, for an owner or admin who sees everyone's; null for the viewer's own list. */
  member: string | null;
  mine: boolean;
  client: string;
  connectedAt: string;
  lastUsedAt: string | null;
}

/** "Oct 15, 2026". */
function onDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function Disconnect({ orgSlug, connectionId }: { orgSlug: string; connectionId: string }) {
  const { state, formProps } = useActionForm(disconnect, INITIAL);
  return (
    <form {...formProps} className="space-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <SubmitButton size="sm" variant="secondary" pendingLabel="Disconnecting…" icon={<Unplug aria-hidden />}>
        Disconnect
      </SubmitButton>
      <FormMessage tone={!state.ok && state.message ? "error" : "neutral"}>{!state.ok ? state.message || null : null}</FormMessage>
    </form>
  );
}

/**
 * Settings' Chrome extension section (docs/superpowers/specs/2026-10-15-invoice-capture-design.md C17): each
 * Vestiarion Invoice Capture connected to this workspace, a person's own or, for an owner or admin, everyone's, with
 * Disconnect, which stops its tokens at once. On a deployment where invoice capture is set up.
 */
export default function ChromeExtensionPanel({
  orgSlug,
  available,
  connections,
  seesEveryone,
}: {
  orgSlug: string;
  /** False before migration 0121. */
  available: boolean;
  connections: ConnectionView[];
  seesEveryone: boolean;
}) {
  if (!available) return <p className="text-sm text-ink-2">Invoice capture is not set up on this deployment yet.</p>;
  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-2">
        Vestiarion Invoice Capture sends invoices you select or choose in Chrome to this workspace as drafts, which an owner or admin adds as bills on Bills
        &amp; receivables. It never adds a bill, approves or pays.{" "}
        <Link href="/docs/guides/invoice-capture" className="font-medium text-agent underline-offset-2 hover:underline">
          Install and connect it
        </Link>
      </p>
      {connections.length === 0 ? (
        <p className="text-sm text-ink-3">{seesEveryone ? "No Chrome extension is connected to this workspace." : "You have not connected a Chrome extension to this workspace."}</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {connections.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-start justify-between gap-3 p-3 sm:p-4">
              <div className="min-w-0 text-sm">
                <p className="font-medium text-ink">
                  Chrome extension <code className="font-mono text-xs">{connection.client.slice(0, 8)}…</code>
                  {connection.member && !connection.mine ? ` · ${connection.member}` : connection.mine && seesEveryone ? " · you" : ""}
                </p>
                <p className="text-xs text-ink-3">
                  Connected {onDay(connection.connectedAt)}
                  {connection.lastUsedAt ? ` · last used ${onDay(connection.lastUsedAt)}` : ""}
                </p>
              </div>
              <Disconnect orgSlug={orgSlug} connectionId={connection.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
