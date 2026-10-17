import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { DocsLink } from "@/components/DocsLink";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { ACTION_TONES, type CollectionsPanelView } from "@/lib/collection-context/view";

/**
 * Collections on the Receivables tab (docs/superpowers/specs/2026-10-13-collections-context-design.md C8): how many
 * receivables wait on a person, the reminders sent this week, and promises kept and broken; then the receivables to look
 * at first, each with the agent's proposed next step and the fact it rests on most, opening the receivable.
 */
export function CollectionsPanel({ panel, available }: { panel: CollectionsPanelView; available: boolean }) {
  const { kept, broken } = panel.promises;
  return (
    <section id="collections" aria-labelledby="collections-title" className="scroll-mt-6 space-y-3">
      <SectionHeader
        id="collections-title"
        title="Collections"
        meta="The next step for each receivable, and why"
        action={<DocsLink href="/docs/guides/collections" topic="chasing what customers owe" />}
      />
      <Card className="overflow-hidden">
        <dl className="grid grid-cols-3 divide-x divide-line border-b border-line">
          <Figure label="Waiting on you" value={panel.waiting} tone={panel.waiting > 0 ? "held" : "default"} sub={panel.waiting === 1 ? "receivable" : "receivables"} />
          <Figure label="Reminders sent" value={panel.sentThisWeek} sub="this week" />
          <Figure label="Promises" value={`${kept} · ${broken}`} sub="kept · broken" tone={broken > 0 ? "held" : "default"} />
        </dl>
        {panel.items.length === 0 ? (
          <p className="px-4 py-4 text-sm text-ink-2">Nothing to chase: no receivable is overdue or due in the next 7 days.</p>
        ) : (
          <ul aria-label="Receivables to look at" className="divide-y divide-line">
            {panel.items.map((item) => (
              <li key={item.invoiceId} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge tone={ACTION_TONES[item.action]} dot size="sm">
                    {item.actionLabel}
                  </Badge>
                  <span className="min-w-0 text-sm font-semibold text-ink">{item.customerName}</span>
                  <span className="text-xs text-ink-3">
                    {item.owed} · {item.due}
                  </span>
                </div>
                <p className="mt-1 text-[0.8125rem] leading-5 text-ink-2">{item.reasons[item.reasons.length - 1]}</p>
                <Link href={item.href} className="mt-1 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-agent underline-offset-4 hover:underline">
                  {item.task ? `${item.task.label}: open it` : "Open the receivable"}
                  <ArrowRight aria-hidden className="size-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {panel.more > 0 && <p className="border-t border-line px-4 py-2.5 text-xs text-ink-3">And {panel.more} more in the list below.</p>}
      </Card>
      {!available && <p className="text-xs text-ink-3">Customer rules and tasks are not set up on this deployment yet: reminders follow the workspace&apos;s schedule.</p>}
    </section>
  );
}

function Figure({ label, value, sub, tone = "default" }: { label: string; value: number | string; sub: string; tone?: "default" | "held" }) {
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <dt className="truncate text-xs font-medium text-ink-3">{label}</dt>
      <dd className={tone === "held" ? "mt-0.5 text-xl font-semibold tabular-nums text-held" : "mt-0.5 text-xl font-semibold tabular-nums text-ink"}>{value}</dd>
      <dd className="truncate text-[0.6875rem] text-ink-3">{sub}</dd>
    </div>
  );
}
