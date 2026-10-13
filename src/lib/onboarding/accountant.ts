import type { Portfolio } from "../accountant/read";
import type { OrgMembership } from "../auth/membership";
import { withOrg } from "../dal/scope";
import type { GettingStarted } from "../getting-started";
import { readOnboardingMarks, readPersonActs, recordOnboardingMarks } from "./read";
import { accountantChecklist, checklistRoleOf, type OnboardingMark } from "./role-checklists";

/**
 * The accountant's checklist on the accountant console (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-
 * access-design.md R3). Read in each workspace where the person is an accountant, in its own scope and as them, as the
 * console reads its queue: never across tenants. Opening the console is its first step, and narrowing it to one of those
 * workspaces with Only this one its second, so this records both (migration 0114), best effort, where they are missing.
 * A step is done when it was done in any of the person's workspaces.
 */

const CONCURRENCY = 4;

export interface AccountantOnboarding {
  checklist: GettingStarted;
  /** The workspace its steps open, where a step is a page of one. */
  slug: string;
  /** Whether a dismissal can be recorded: false before migration 0114 runs. */
  canDismiss: boolean;
}

type Facts = { available: boolean; marks: ReadonlySet<OnboardingMark>; booked: boolean; applied: boolean; handedOff: boolean };

/**
 * Null for someone who is no workspace's accountant: the console shows them no checklist. `queueSlug` is the workspace
 * the console is narrowed to, if any.
 */
export async function readAccountantOnboarding(
  userId: string,
  memberships: readonly OrgMembership[],
  portfolio: Portfolio,
  queueSlug: string | null
): Promise<AccountantOnboarding | null> {
  const books = memberships.filter((membership) => checklistRoleOf(membership.role) === "accountant");
  if (books.length === 0) return null;

  const facts: Facts[] = [];
  for (let start = 0; start < books.length; start += CONCURRENCY) {
    facts.push(
      ...(await Promise.all(
        books.slice(start, start + CONCURRENCY).map((membership) =>
          withOrg(
            membership.orgId,
            async (): Promise<Facts> => {
              const [marks, acts] = await Promise.all([readOnboardingMarks(userId), readPersonActs(userId)]);
              const seen: OnboardingMark[] = ["accountant_console_opened", ...(membership.slug === queueSlug ? (["accountant_queue_opened"] as const) : [])];
              const missing = seen.filter((mark) => !marks.mine.has(mark));
              if (marks.available && missing.length > 0) await recordOnboardingMarks(userId, missing);
              return { available: marks.available, marks: new Set([...marks.mine, ...seen]), ...acts };
            },
            { userId }
          ).catch((error: unknown): Facts => {
            console.error("onboarding: an accountant's workspace not read", error instanceof Error ? error.message : "unknown error");
            return { available: false, marks: new Set(), booked: false, applied: false, handedOff: false };
          })
        )
      ))
    );
  }

  const any = (mark: OnboardingMark) => facts.some((fact) => fact.marks.has(mark));
  const slugs = new Set(books.map((membership) => membership.slug));
  // A booking this person may make now, in one of the workspaces they keep the books of: the step opens it there.
  const booking = portfolio.items.find((item) => item.kind === "to_book" && item.canAct && slugs.has(item.workspace.slug));
  const workspaceSlug = booking?.workspace.slug ?? (queueSlug && slugs.has(queueSlug) ? queueSlug : books[0].slug);
  const prefix = `/o/${workspaceSlug}`;
  const bookHref = booking && booking.href.startsWith(`${prefix}/`) ? booking.href.slice(prefix.length) : null;

  return {
    slug: workspaceSlug,
    canDismiss: facts.some((fact) => fact.available),
    checklist: accountantChecklist({
      consoleOpened: true,
      queueOpened: any("accountant_queue_opened"),
      booked: facts.some((fact) => fact.booked),
      applied: facts.some((fact) => fact.applied),
      handedOff: facts.some((fact) => fact.handedOff),
      workspaceSlug,
      bookHref,
      dismissed: any("dismissed_accountant"),
    }),
  };
}
