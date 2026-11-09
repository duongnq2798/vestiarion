import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { PAYEE_LINKS_SHOWN, type PayeeLinkLine, type PayeeLinkState } from "@/lib/counterparties/page-view";

const TONE: Record<PayeeLinkState["kind"], NonNullable<BadgeProps["tone"]>> = {
  out: "agent",
  used: "proof",
  replaced: "neutral",
  revoked: "neutral",
  expired: "neutral",
};

/**
 * A payee's latest payee links under Payee link on its page (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL6), newest first, from `payeeLinkStates`: out, replaced by a newer link, revoked, expired unused, or used with its
 * invoice; and who made each. Never a link's address or its token: those are shown once, when the link is made (CL4).
 * Nothing when no link was ever made: the control above says what is out.
 */
export function PayeeLinkHistory({ lines }: { lines: readonly PayeeLinkLine[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="mt-3 border-t border-line pt-3">
      <ul className="space-y-1.5 text-xs" aria-label="Payee links">
        {lines.map((line) => (
          <li key={line.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <Badge size="sm" dot tone={TONE[line.state.kind]}>
              {line.label}
            </Badge>
            {line.invoice && <span className="text-ink-2">{line.invoice}</span>}
            <span className="text-ink-3">{line.madeBy}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-3">The latest {PAYEE_LINKS_SHOWN} links; every one is in History and the Audit log.</p>
      {/* As long as payee_link_status answers a used link (payee invoice link P6). */}
      <p className="mt-0.5 text-xs text-ink-3">A used link&apos;s status page stays open to the payee for 30 days.</p>
    </div>
  );
}
