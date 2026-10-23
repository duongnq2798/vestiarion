import type { Portfolio } from "../accountant/read";
import type { OrgMembership } from "../auth/membership";
import { withOrg } from "../dal/scope";
import type { GettingStarted } from "../getting-started";
import { readOnboardingMarks, readPersonActs } from "./read";
import { accountantChecklist, checklistRoleOf, type OnboardingMark } from "./role-checklists";

/**
 * The accountant's checklist on the accountant console (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-
 * access-design.md R3). Read in each workspace where the person is an accountant, in its own scope and as them, as the
 * console reads its queue: never across tenants. Opening the console is its first step, and narrowing it to one of those
 * workspaces with Only this one its second. Reading writes nothing: the page renders, and once it is in the browser,
 * `recordAccountantVisitAction` records both in each workspace still missing them (migration 0114), best effort
 * (Next.js forbids a mutation while a page renders, and a prefetch could tick a step for a console nobody opened). A
 * step is done when it was done in any of the person's workspaces.
 */

const CONCURRENCY = 4;

export interface AccountantOnboarding {
  checklist: GettingStarted;
  /** The workspace its steps open, where a step is a page of one. */
  slug: string;
  /** Whether a dismissal can be recorded: false before migration 0114 runs. */
  canDismiss: boolean;
  /** The workspaces, by slug, that can record this visit and do not hold it yet: the page has it recorded there. */
  unrecorded: string[];
}

type Facts = { slug: string; available: boolean; unrecorded: boolean; marks: ReadonlySet<OnboardingMark>; booked: boolean; applied: boolean; handedOff: boolean };

const isBooks = (membership: OrgMembership) => checklistRoleOf(membership.role) === "accountant";

/** What opening the console marks in one of the person's accountant workspaces: the console, and its queue if narrowed to it. */
export function accountantVisitMarks(slug: string, queueSlug: string | null): OnboardingMark[] {
  return ["accountant_console_opened", ...(slug === queueSlug ? (["accountant_queue_opened"] as const) : [])];
}

/** Each of `books`, a few at a time. */
async function inTurn<T>(books: readonly OrgMembership[], each: (membership: OrgMembership) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let start = 0; start < books.length; start += CONCURRENCY) out.push(...(await Promise.all(books.slice(start, start + CONCURRENCY).map(each))));
  return out;
}

/**
 * Null for someone who is no workspace's accountant: the console shows them no checklist. `queueSlug` is the workspace
 * the console is narrowed to, if any. `clientInvited`, given where client links work, offers the optional Invite a client
 * step, done once one of this person's links was used (accountant client links AC6).
 */
export async function readAccountantOnboarding(
  userId: string,
  memberships: readonly OrgMembership[],
  portfolio: Portfolio,
  queueSlug: string | null,
  clientInvited?: boolean
): Promise<AccountantOnboarding | null> {
  const books = memberships.filter(isBooks);
  if (books.length === 0) return null;

  const facts = await inTurn(books, (membership) =>
    withOrg(
      membership.orgId,
      async (): Promise<Facts> => {
        const [marks, acts] = await Promise.all([readOnboardingMarks(userId), readPersonActs(userId)]);
        // This visit ticks its steps now; it is recorded once the page is in the browser (`recordAccountantVisitAction`).
        const seen = accountantVisitMarks(membership.slug, queueSlug);
        const unrecorded = marks.available && seen.some((mark) => !marks.mine.has(mark));
        return { slug: membership.slug, available: marks.available, unrecorded, marks: new Set([...marks.mine, ...seen]), ...acts };
      },
      { userId }
    ).catch((error: unknown): Facts => {
      console.error("onboarding: an accountant's workspace not read", error instanceof Error ? error.message : "unknown error");
      return { slug: membership.slug, available: false, unrecorded: false, marks: new Set(), booked: false, applied: false, handedOff: false };
    })
  );

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
    unrecorded: facts.filter((fact) => fact.unrecorded).map((fact) => fact.slug),
    checklist: accountantChecklist({
      consoleOpened: true,
      queueOpened: any("accountant_queue_opened"),
      booked: facts.some((fact) => fact.booked),
      applied: facts.some((fact) => fact.applied),
      handedOff: facts.some((fact) => fact.handedOff),
      workspaceSlug,
      bookHref,
      ...(clientInvited === undefined ? {} : { clientInvited }),
      dismissed: any("dismissed_accountant"),
    }),
  };
}
