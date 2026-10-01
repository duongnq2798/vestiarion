import { ArrowRight, BookOpen, Check } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { cn } from "@/components/ui/cn";
import { orgHref } from "@/lib/auth/org-paths";
import type { GettingStarted as Checklist } from "@/lib/getting-started";

/**
 * The console's Get started checklist (getting-started design §1, first-payment
 * design §2): six steps to a first payment on Arc testnet, ticked from the
 * workspace's own rows, with the next one highlighted and linked. The console
 * renders it for owners and admins until that payment; `isOwner` says whether
 * the owner-only steps are this person's to take.
 */
export function GettingStarted({ slug, checklist, isOwner }: { slug: string; checklist: Checklist; isOwner: boolean }) {
  if (!checklist.show) return null;
  const doneCount = checklist.steps.filter((step) => step.done).length;

  return (
    <section aria-labelledby="getting-started-title" className="mb-8">
      <SectionHeader
        id="getting-started-title"
        title="Get started"
        meta={`${doneCount} of ${checklist.steps.length} done`}
        action={
          <Button asChild size="sm" variant="ghost">
            <Link href={`/docs/guides/${checklist.guide}`}>
              <BookOpen aria-hidden />
              Read the guide
            </Link>
          </Button>
        }
      />
      <Card asChild className="p-2 sm:p-3">
        <ol>
          {checklist.steps.map((step, index) => {
            const next = step.id === checklist.next;
            const ownerStepForAdmin = step.ownerOnly && !isOwner && !step.done;
            return (
              <li
                key={step.id}
                aria-current={next ? "step" : undefined}
                className={cn("flex items-start gap-3 rounded-xl px-3 py-3", next && "bg-agent-soft")}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
                    step.done ? "border-proof-line bg-proof-soft text-proof" : next ? "border-agent-line text-agent" : "border-line text-ink-3"
                  )}
                >
                  {step.done ? <Check className="size-3.5" /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-semibold", step.done ? "text-ink-3" : "text-ink")}>
                    {step.title}
                    {step.done && <span className="sr-only"> (done)</span>}
                  </p>
                  {!step.done && (
                    <p className="mt-0.5 text-sm text-ink-2">
                      {step.body}
                      {ownerStepForAdmin && " An owner of this workspace does this step."}
                    </p>
                  )}
                </div>
                {next && (
                  <Button asChild size="sm" variant="secondary" className="shrink-0">
                    <Link href={orgHref(slug, step.path)}>
                      {ownerStepForAdmin ? "View" : "Start"}
                      <ArrowRight aria-hidden />
                    </Link>
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </Card>
    </section>
  );
}
