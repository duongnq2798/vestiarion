import type { OrgDb } from "../dal";
import { projectsNotReady, reserveProjectBudget } from "../projects/reserve";
import { sameWorkMatches, type SameWorkMatch, type WorkItem } from "../projects/same-work";
import { projectCheckOf, type ProjectCheck } from "./obligation-checks";

/**
 * What the AP and contractor stages need for the checks after the guardrails (./obligation-checks.ts), read once per
 * stage: the other book, to find the same work billed as the other kind, and the reservation of a project's money.
 */
export interface ObligationGate {
  /** The earlier bills or milestones of the other kind that this one repeats. */
  sameWork(subject: WorkItem): SameWorkMatch[];
  /**
   * Sets the money of a bill or milestone aside in its project, under the database's lock. Null for one in no project,
   * which is never asked; `unreadable` when the reservation could not be made or read, which holds it.
   */
  reserve(subject: { invoiceId: string } | { milestoneId: string }, projectId: string | null): Promise<ProjectCheck | null>;
}

interface MilestoneRow {
  id: string;
  contractor_id: string;
  title: string;
  status: string;
  created_at: string;
  verification_source: string | null;
  po_reference?: string | null;
}

interface BillRow {
  id: string;
  counterparty_id: string;
  memo: string | null;
  po_reference: string | null;
  status: string;
  created_at: string;
  amount: string | number;
}

const PAGE = 1000;

/** The workspace's milestones as a bill is compared with them: their purchase order once 0111 runs, their evidence. */
async function milestoneItems(orgDb: OrgDb): Promise<WorkItem[]> {
  const read = (columns: string) => orgDb.from("milestones").select(columns).neq("status", "closed").order("created_at", { ascending: true }).range(0, PAGE - 1);
  let answer = await read("id, contractor_id, title, status, created_at, verification_source, po_reference");
  // Before 0111 there is no purchase order on a milestone: its evidence is still compared.
  if (projectsNotReady(answer.error)) answer = await read("id, contractor_id, title, status, created_at, verification_source");
  if (answer.error) throw new Error(answer.error.message);
  return ((answer.data ?? []) as unknown as MilestoneRow[]).map((row) => ({
    kind: "milestone",
    id: row.id,
    counterpartyId: row.contractor_id,
    label: row.title,
    poReference: row.po_reference ?? null,
    evidence: row.verification_source,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/** The workspace's bills as a milestone is compared with them: their purchase order, and their memo as evidence. */
async function billItems(orgDb: OrgDb): Promise<WorkItem[]> {
  const answer = await orgDb
    .from("invoices")
    .select("id, counterparty_id, memo, po_reference, status, created_at, amount")
    .eq("direction", "payable")
    .neq("status", "rejected")
    .order("created_at", { ascending: true })
    .range(0, PAGE - 1);
  if (answer.error) throw new Error(answer.error.message);
  return ((answer.data ?? []) as unknown as BillRow[]).map((row) => ({
    kind: "bill",
    id: row.id,
    counterpartyId: row.counterparty_id,
    label: row.memo?.trim() || `Bill for ${Number(row.amount)} USDC`,
    poReference: row.po_reference,
    evidence: row.memo,
    status: row.status,
    createdAt: row.created_at,
  }));
}

/**
 * The gate for one stage: `bill` for the AP stage, which compares each bill with the milestones; `milestone` for the
 * contractor stage, which compares each milestone with the bills. A read of the other book that fails throws, and the
 * stage fails, as a limit no one could read pays nothing.
 */
export async function loadObligationGate(orgDb: OrgDb, deciding: "bill" | "milestone"): Promise<ObligationGate> {
  const others = deciding === "bill" ? await milestoneItems(orgDb) : await billItems(orgDb);
  return {
    sameWork: (subject) => sameWorkMatches(subject, others),
    async reserve(subject, projectId) {
      if (!projectId) return null;
      try {
        const answer = await reserveProjectBudget(orgDb, subject, "agent", null);
        return answer.state === "not_ready" ? { state: "unreadable", projectId } : projectCheckOf(answer);
      } catch (error) {
        console.error("project budget not reserved", "invoiceId" in subject ? subject.invoiceId : subject.milestoneId, error instanceof Error ? error.message : error);
        return { state: "unreadable", projectId };
      }
    },
  };
}

/** A gate with nothing to compare and no project: what a stage with nothing to decide, or a test, passes. */
export const NO_OBLIGATIONS: ObligationGate = {
  sameWork: () => [],
  reserve: async () => null,
};
