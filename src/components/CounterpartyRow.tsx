import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Disclosure } from "@/components/ui/Disclosure";
import { Money, shortHash } from "@/components/vx/Primitives";
import { addressUnconfirmed } from "@/lib/counterparty-address";
import { chainById, homeChain } from "@/lib/payee-chains";
import type { Network } from "@/lib/network";
import type { CounterpartyRow as CounterpartyRecord } from "@/lib/queries";

/**
 * One counterparty in the Counterparty book (Counterparties layout): its name, role and chain, risk, what it may
 * be paid now, its address, and what it needs before the agent can pay it; opening the row shows the rest, as
 * `children`. The docs' screenshots draw the same row.
 */

export const RISK_TONE: Record<string, NonNullable<BadgeProps["tone"]>> = {
  clear: "proof",
  medium: "held",
  high: "refused",
  unscreened: "neutral",
};

/** What a counterparty needs before the agent can pay it, worst first. */
export type Readiness = { label: string; tone: NonNullable<BadgeProps["tone"]>; rank: number };

type Fields = Pick<CounterpartyRecord, "risk_level" | "risk_notes" | "address" | "address_changed_at" | "address_confirmed_at" | "role">;

export function readiness(counterparty: Fields): Readiness {
  if ((counterparty.risk_level === "medium" || counterparty.risk_level === "high") && counterparty.risk_notes) return { label: "Review match", tone: "held", rank: 0 };
  if (addressUnconfirmed(counterparty.address_changed_at, counterparty.address_confirmed_at)) return { label: "Confirm address", tone: "held", rank: 1 };
  if (counterparty.role !== "client" && !counterparty.address) return { label: "Address needed", tone: "held", rank: 2 };
  // Screening could not run yet: the agent pays it nothing until it has a verdict (unscreened hold R8).
  if (counterparty.role !== "client" && counterparty.risk_level === "unscreened") return { label: "Not screened yet", tone: "held", rank: 2 };
  if (counterparty.role === "client") return { label: "Client", tone: "neutral", rank: 4 };
  return { label: "Ready to pay", tone: "proof", rank: 3 };
}

export function CounterpartyRow({
  counterparty,
  defaultOpen,
  children,
  network,
}: {
  /** The workspace's network: its explorer links what this shows (network threading P6). */
  network: Network;
  counterparty: Fields & Pick<CounterpartyRecord, "id" | "name" | "chain" | "payment_limit"> & { sample?: boolean };
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const ready = readiness(counterparty);
  const role = (
    <>
      <span className="capitalize">{counterparty.role}</span> · {(counterparty.chain ? chainById(counterparty.chain) : homeChain(network)).label}
    </>
  );
  const risk = (className?: string) => (
    <Badge size="sm" dot tone={RISK_TONE[counterparty.risk_level] ?? "neutral"} className={`capitalize ${className ?? ""}`}>
      {counterparty.risk_level}
    </Badge>
  );
  return (
    <Disclosure
      variant="bare"
      // A link to this row (a stopped payable's "Edit limit", "Confirm address") opens it: see ScrollToHash.
      id={`counterparty-${counterparty.id}`}
      defaultOpen={defaultOpen}
      summaryClassName="grid grid-cols-[minmax(0,1fr)_auto_1rem] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors duration-150 ease-standard hover:bg-ground/50 md:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_8.5rem_1rem] sm:px-5 xl:grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_8.5rem_8.5rem_1rem]"
      summary={
        <>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
              <span className="truncate">{counterparty.name}</span>
              {counterparty.sample && <Badge size="sm" tone="simulated" shape="tag">Sample</Badge>}
            </span>
            <span className="block truncate text-xs text-ink-3">{role}</span>
          </span>
          <span className="hidden md:block">{risk()}</span>
          <span className="hidden text-right text-xs md:block">
            <span className="block text-ink-3">Allowed now</span>
            <span className="text-ink">{counterparty.payment_limit == null ? "Not set" : <Money value={counterparty.payment_limit} />}</span>
          </span>
          <span className="hidden font-mono text-xs text-ink-2 xl:block" title={counterparty.address ?? undefined}>
            {counterparty.address ? shortHash(counterparty.address) : "No address"}
          </span>
          <span className="justify-self-end">
            <Badge size="sm" tone={ready.tone}>{ready.label}</Badge>
          </span>
          <ChevronRight aria-hidden className="size-4 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
        </>
      }
    >
      <article className="border-t border-line bg-ground/40 px-4 py-4 sm:px-5" aria-label={counterparty.name}>
        {/* The row says all this on a wide screen; a narrow one shows only the name and what it needs. */}
        <div className="flex items-start justify-between gap-3 md:hidden">
          <div className="min-w-0">
            <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-ink">
              <span className="truncate">{counterparty.name}</span>
              {counterparty.sample && <Badge size="sm" tone="simulated" shape="tag">Sample</Badge>}
            </h3>
            <p className="mt-0.5 text-xs text-ink-3">{role}</p>
          </div>
          {risk("shrink-0")}
        </div>
        {children}
      </article>
    </Disclosure>
  );
}
