import { ArrowRight, BookOpen, Check, Download, EyeOff } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { cn } from "@/components/ui/cn";
import { orgHref } from "@/lib/auth/org-paths";
import type { GettingStarted as Checklist, GettingStartedStep } from "@/lib/getting-started";

type FormAction = (formData: FormData) => void | Promise<void>;

/** The button that dismisses a checklist for good (R4). */
export const DONT_SHOW_AGAIN = "Don't show again";

/** What "Don't show again" says it does, read by a screen reader and shown on hover. */
export const DISMISS_FOR_GOOD = "Hide this checklist for good. It does not come back for you in this workspace.";

/**
 * A member's checklist on the console (getting-started design §1, first-payment design §2; onboarding by role,
 * docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md): the owner's steps to a first payment, an
 * approver's to a first decision, an accountant's to a first booking and hand-off, each ticked from the workspace's own
 * rows, with the next one highlighted and linked. `isOwner` says whether the owner-only steps are this person's to take.
 * Steps with a `section` are listed under it, numbered on from the steps before: a sandbox with no wallet lists the
 * steps to real payments under "To pay on Arc".
 *
 * `dismiss`, given where the page can record it, offers "Don't show again" (R4); `confirmLimits`, given to a person who
 * may change the agent's limits, offers "Keep these limits" on that step (R1). Both are forms: nothing here runs in the
 * browser.
 */
export function GettingStarted({
  slug,
  checklist,
  isOwner,
  dismiss,
  confirmLimits,
}: {
  slug: string;
  checklist: Checklist;
  isOwner: boolean;
  dismiss?: FormAction;
  confirmLimits?: FormAction;
}) {
  if (!checklist.show) return null;
  const role = checklist.role ?? "owner";
  const titleId = `getting-started-title${role === "owner" ? "" : `-${role}`}`;
  const doneCount = checklist.steps.filter((step) => step.done).length;
  // Consecutive steps under the same heading, each with its number in the whole list.
  const groups: Array<{ section?: string; start: number; steps: GettingStartedStep[] }> = [];
  checklist.steps.forEach((step, index) => {
    const last = groups.at(-1);
    if (last && last.section === step.section) last.steps.push(step);
    else groups.push({ section: step.section, start: index + 1, steps: [step] });
  });

  const stepLink = (step: GettingStartedStep, label: string) => {
    const href = step.href ?? orgHref(slug, step.path);
    const content = (
      <>
        {label}
        {step.download ? <Download aria-hidden /> : <ArrowRight aria-hidden />}
      </>
    );
    // A download is a plain link: nothing to prefetch, and the browser saves what it answers.
    return (
      <Button asChild size="sm" variant="secondary" className="shrink-0">
        {step.download ? (
          <a href={href} download>
            {content}
          </a>
        ) : (
          <Link href={href}>{content}</Link>
        )}
      </Button>
    );
  };

  const item = (step: GettingStartedStep, number: number) => {
    const next = step.id === checklist.next;
    const ownerStepForAdmin = step.ownerOnly && !isOwner && !step.done;
    const keepLimits = step.id === "limits" && !step.done && confirmLimits;
    return (
      <li key={step.id} aria-current={next ? "step" : undefined} className={cn("flex items-start gap-3 rounded-xl px-3 py-3", next && "bg-agent-soft")}>
        <span
          aria-hidden
          className={cn(
            "mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold tabular-nums",
            step.done ? "border-proof-line bg-proof-soft text-proof" : next ? "border-agent-line text-agent" : "border-line text-ink-3"
          )}
        >
          {step.done ? <Check className="size-3.5" /> : number}
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm font-semibold", step.done ? "text-ink-3" : "text-ink")}>
            {step.title}
            {step.done && <span className="sr-only"> (done)</span>}
          </p>
          {!step.done && step.body && (
            <p className="mt-0.5 text-sm text-ink-2">
              {step.body}
              {ownerStepForAdmin && " An owner of this workspace does this step."}
            </p>
          )}
          {keepLimits && (
            <form action={confirmLimits} className="mt-2">
              <input type="hidden" name="orgSlug" value={slug} />
              <Button type="submit" size="sm" variant="ghost" icon={<Check aria-hidden />}>
                Keep these limits
              </Button>
            </form>
          )}
        </div>
        {next && stepLink(step, ownerStepForAdmin ? "View" : step.download ? "Download" : "Start")}
      </li>
    );
  };

  return (
    <section aria-labelledby={titleId} className="mb-8" data-checklist-role={role}>
      <SectionHeader
        id={titleId}
        title={checklist.title ?? "Get started"}
        meta={`${doneCount} of ${checklist.steps.length} done`}
        action={
          <div className="flex flex-wrap items-center gap-1">
            <Button asChild size="sm" variant="ghost">
              <Link href={`/docs/guides/${checklist.guide}`}>
                <BookOpen aria-hidden />
                Read the guide
              </Link>
            </Button>
            {dismiss && (
              <form action={dismiss}>
                <input type="hidden" name="orgSlug" value={slug} />
                <input type="hidden" name="role" value={role} />
                <Button type="submit" size="sm" variant="ghost" icon={<EyeOff aria-hidden />} title={DISMISS_FOR_GOOD} aria-describedby={`${titleId}-dismiss`}>
                  {DONT_SHOW_AGAIN}
                </Button>
                <span id={`${titleId}-dismiss`} className="sr-only">
                  {DISMISS_FOR_GOOD}
                </span>
              </form>
            )}
          </div>
        }
      />
      <Card asChild className="p-2 sm:p-3">
        {groups.length === 1 && !groups[0].section ? (
          <ol>{checklist.steps.map((step, index) => item(step, index + 1))}</ol>
        ) : (
          <div>
            {groups.map((group) => {
              const headingId = group.section ? `getting-started-${role === "owner" ? "" : `${role}-`}${group.start}` : undefined;
              return (
                <div key={group.start} className={cn(group.start > 1 && "mt-1 border-t border-line pt-1")}>
                  {group.section && (
                    <h3 id={headingId} className="px-3 pb-1 pt-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em] text-ink-3">
                      {group.section}
                    </h3>
                  )}
                  <ol start={group.start} aria-labelledby={headingId}>
                    {group.steps.map((step, index) => item(step, group.start + index))}
                  </ol>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </section>
  );
}
