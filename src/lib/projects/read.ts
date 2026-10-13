import { db, type OrgDb } from "../dal";
import { PROJECT_BUDGET_RULE, SAME_WORK_RULE } from "../agent/obligation-checks";
import { readDealCollections } from "../deals/collection-read";
import { readDeals, type DealRecord } from "../deals/read";
import { NO_MONEY, obligationMinor, projectFigures, workState, type Project, type ProjectFigures, type ProjectMoney, type ProjectWork } from "./model";
import { projectsNotReady } from "./reserve";

/**
 * A workspace's projects, read in its own scope (docs/superpowers/specs/2026-10-13-project-budgets-design.md P7, P8):
 * each project with its figures as migration 0111's `project_figures` counts them, the payments the agent held for its
 * budget, and the revenue its deals collected (`dealCollection`, the one figure behind a deal's Paid). Until 0111 runs,
 * every read answers that projects are not set up, and the pages say so.
 */

export const PROJECT_COLUMNS = "id, name, budget_minor, buffer_minor, status, created_at";

interface ProjectRow {
  id: string;
  name: string;
  budget_minor: number | string;
  buffer_minor: number | string;
  status: "active" | "archived";
  created_at: string;
}

interface FigureRow {
  project_id: string;
  reserved_minor: number | string;
  paid_minor: number | string;
  open_minor: number | string;
  open_count: number;
  unreserved_minor: number | string;
  unreserved_count: number;
}

/** What a project's deals collected: in USDC cents, which the budget is in, and in any other currency apart. */
export interface ProjectRevenue {
  deals: number;
  usdcMinor: number;
  /** Collected in another currency than USDC, never added to it. */
  other: Array<{ currency: string; minor: number; digits: 0 | 2 }>;
}

export const NO_REVENUE: ProjectRevenue = { deals: 0, usdcMinor: 0, other: [] };

export interface ProjectSummary {
  project: Project;
  figures: ProjectFigures;
  revenue: ProjectRevenue;
}

export type ProjectsRead = { available: false } | { available: true; projects: ProjectSummary[] };

const toProject = (row: ProjectRow): Project => ({
  id: row.id,
  name: row.name,
  budgetMinor: Number(row.budget_minor),
  bufferMinor: Number(row.buffer_minor),
  status: row.status,
  createdAt: row.created_at,
});

const toMoney = (row: FigureRow | undefined): ProjectMoney =>
  row
    ? {
        reservedMinor: Number(row.reserved_minor),
        paidMinor: Number(row.paid_minor),
        openMinor: Number(row.open_minor),
        openCount: Number(row.open_count),
        unreservedMinor: Number(row.unreserved_minor),
        unreservedCount: Number(row.unreserved_count),
      }
    : NO_MONEY;

const DAY_MS = 86_400_000;
const HOLDS_READ = 1000;

interface HoldEntry {
  ts: string;
  rule: string | null;
  invoiceId: string | null;
  milestoneId: string | null;
  projectId: string | null;
}

/** The agent's decisions of the last 30 days held for a project's budget or as the same work, newest first. */
async function readHoldEntries(orgDb: OrgDb, now: Date): Promise<HoldEntry[]> {
  const since = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const read = await orgDb
    .from("ledger_entries")
    .select("ts, rule:detail->>guardrailRule, invoiceId:detail->>invoiceId, milestoneId:detail->>milestoneId, projectId:detail->observed->>projectId")
    .eq("actor", "agent")
    .in("detail->>guardrailRule", [PROJECT_BUDGET_RULE, SAME_WORK_RULE])
    .gte("ts", since)
    .order("seq", { ascending: false })
    .limit(HOLDS_READ);
  if (read.error) throw new Error(read.error.message);
  return (read.data ?? []) as unknown as HoldEntry[];
}

const IDS_PER_READ = 100;

/** Bills and milestones held now, by id: whose holds count as "held now". A hundred ids a read, so no address grows too long. */
async function heldNow(orgDb: OrgDb, entries: HoldEntry[]): Promise<Set<string>> {
  const held = new Set<string>();
  const read = async (table: "invoices" | "milestones", ids: string[]) => {
    for (let at = 0; at < ids.length; at += IDS_PER_READ) {
      const answer = await orgDb.from(table).select("id").in("id", ids.slice(at, at + IDS_PER_READ)).eq("status", "held");
      if (answer.error) throw new Error(answer.error.message);
      for (const row of (answer.data ?? []) as Array<{ id: string }>) held.add(row.id);
    }
  };
  await read("invoices", [...new Set(entries.flatMap((entry) => (entry.invoiceId ? [entry.invoiceId] : [])))]);
  await read("milestones", [...new Set(entries.flatMap((entry) => (entry.milestoneId ? [entry.milestoneId] : [])))]);
  return held;
}

/** Payments held for each project's budget: still held now, and decisions in the last 30 days. */
function holdsByProject(entries: HoldEntry[], held: Set<string>): Map<string, { now: number; last30Days: number }> {
  const byProject = new Map<string, { now: number; last30Days: number; subjects: Set<string> }>();
  for (const entry of entries) {
    if (entry.rule !== PROJECT_BUDGET_RULE || !entry.projectId) continue;
    const counts = byProject.get(entry.projectId) ?? { now: 0, last30Days: 0, subjects: new Set<string>() };
    counts.last30Days += 1;
    const subject = entry.invoiceId ?? entry.milestoneId;
    if (subject && held.has(subject) && !counts.subjects.has(subject)) {
      counts.subjects.add(subject);
      counts.now += 1;
    }
    byProject.set(entry.projectId, counts);
  }
  return new Map([...byProject].map(([id, counts]) => [id, { now: counts.now, last30Days: counts.last30Days }]));
}

/** What the deals of each project collected, from the one collection read behind a deal's page. Best effort: none on failure. */
async function revenueByProject(orgDb: OrgDb, today: string): Promise<Map<string, ProjectRevenue>> {
  const revenue = new Map<string, ProjectRevenue>();
  try {
    const members = await orgDb.from("deals").select("id, project_id").not("project_id", "is", null);
    if (members.error) throw new Error(members.error.message);
    const projectOf = new Map(((members.data ?? []) as Array<{ id: string; project_id: string }>).map((row) => [row.id, row.project_id]));
    if (projectOf.size === 0) return revenue;
    const read = await readDeals(orgDb);
    if (!read.available) return revenue;
    const deals: DealRecord[] = read.deals.filter((deal) => projectOf.has(deal.facts.id));
    const collected = await readDealCollections(deals, today, orgDb);
    for (const deal of deals) {
      const projectId = projectOf.get(deal.facts.id) as string;
      const sum = revenue.get(projectId) ?? { deals: 0, usdcMinor: 0, other: [] };
      sum.deals += 1;
      const collection = collected.get(deal.facts.id)?.collection;
      if (collection) {
        if (collection.currency === "USDC") sum.usdcMinor += collection.collectedMinor;
        else if (collection.collectedMinor > 0) {
          const other = sum.other.find((entry) => entry.currency === collection.currency);
          if (other) other.minor += collection.collectedMinor;
          else sum.other.push({ currency: collection.currency, minor: collection.collectedMinor, digits: collection.digits });
        }
      }
      revenue.set(projectId, sum);
    }
  } catch (error) {
    console.error("projects: revenue not read", error instanceof Error ? error.message : error);
  }
  return revenue;
}

/** Every project of the workspace, active first, then by when it was made, with its figures; `revenue: false` skips the deals' collections. */
export async function readProjects(orgDb: OrgDb = db(), now: Date = new Date(), options: { revenue?: boolean } = {}): Promise<ProjectsRead> {
  const projects = await orgDb.from("projects").select(PROJECT_COLUMNS).order("created_at", { ascending: true });
  if (projectsNotReady(projects.error)) return { available: false };
  if (projects.error) throw new Error(projects.error.message);
  const rows = (projects.data ?? []) as unknown as ProjectRow[];
  if (rows.length === 0) return { available: true, projects: [] };
  const figures = await orgDb.rpc("project_figures");
  if (projectsNotReady(figures.error)) return { available: false };
  if (figures.error) throw new Error(figures.error.message);
  const moneyOf = new Map(((figures.data ?? []) as FigureRow[]).map((row) => [row.project_id, row]));
  const entries = await readHoldEntries(orgDb, now);
  const holds = holdsByProject(entries, await heldNow(orgDb, entries));
  const revenue = options.revenue === false ? new Map<string, ProjectRevenue>() : await revenueByProject(orgDb, now.toISOString().slice(0, 10));
  const summaries = rows.map((row) => {
    const project = toProject(row);
    return {
      project,
      figures: projectFigures(project, toMoney(moneyOf.get(row.id)), holds.get(row.id) ?? { now: 0, last30Days: 0 }),
      revenue: revenue.get(row.id) ?? NO_REVENUE,
    };
  });
  return { available: true, projects: [...summaries.filter((entry) => entry.project.status === "active"), ...summaries.filter((entry) => entry.project.status !== "active")] };
}

/**
 * The active projects, for a form's choice of project. Null before projects are set up (migration 0111), when the forms
 * show neither the project nor a milestone's purchase order; empty when none can be read now.
 */
export async function readProjectOptions(orgDb: OrgDb = db()): Promise<Array<{ id: string; name: string }> | null> {
  try {
    const read = await orgDb.from("projects").select("id, name").eq("status", "active").order("name", { ascending: true });
    if (projectsNotReady(read.error)) return null;
    if (read.error) throw new Error(read.error.message);
    return (read.data ?? []) as Array<{ id: string; name: string }>;
  } catch (error) {
    console.error("projects: options not read", error instanceof Error ? error.message : error);
    return null;
  }
}

/** A deal of a project, with what it collected. */
export interface ProjectDeal {
  id: string;
  title: string;
  customer: string;
  currency: string;
  digits: 0 | 2;
  totalMinor: number;
  collectedMinor: number | null;
}

/** Something that can be put in a project: an open bill in USDC, an open milestone, or a deal, in no project yet. */
export interface ProjectCandidate {
  kind: "bill" | "milestone" | "deal";
  id: string;
  label: string;
}

export interface ProjectDetail {
  summary: ProjectSummary;
  /** What every project of the workspace has set aside now, in USDC cents: the treasury's earmarks together. */
  setAsideAllMinor: number;
  work: ProjectWork[];
  deals: ProjectDeal[];
  candidates: ProjectCandidate[];
}

export type ProjectRead = { available: false } | { available: true; detail: ProjectDetail | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANDIDATES_READ = 100;

interface WorkRow {
  id: string;
  amount: string | number;
  status: string;
  memo?: string | null;
  title?: string;
  due_date?: string | null;
  counterparties: { name: string } | null;
}

/** One project, with its bills and milestones, its deals, and what may be put in it. Null for one the workspace has not. */
export async function readProject(projectId: string, orgDb: OrgDb = db(), now: Date = new Date()): Promise<ProjectRead> {
  const all = await readProjects(orgDb, now);
  if (!all.available) return all;
  const summary = UUID.test(projectId) ? all.projects.find((entry) => entry.project.id === projectId) : undefined;
  if (!summary) return { available: true, detail: null };

  const [bills, milestones, reservations, entries] = await Promise.all([
    orgDb.from("invoices").select("id, amount, status, memo, due_date, counterparties(name)").eq("project_id", projectId).eq("direction", "payable").order("due_date", { ascending: true }),
    orgDb.from("milestones").select("id, amount, status, title, counterparties(name)").eq("project_id", projectId).order("created_at", { ascending: true }),
    orgDb.from("project_reservations").select("invoice_id, milestone_id").eq("project_id", projectId).is("released_at", null),
    readHoldEntries(orgDb, now),
  ]);
  for (const read of [bills, milestones, reservations]) if (read.error) throw new Error(read.error.message);
  const reserved = new Set(((reservations.data ?? []) as Array<{ invoice_id: string | null; milestone_id: string | null }>).flatMap((row) => [row.invoice_id, row.milestone_id].filter((id): id is string => id !== null)));
  const latestRule = new Map<string, string | null>();
  for (const entry of entries) {
    const subject = entry.invoiceId ?? entry.milestoneId;
    if (subject && !latestRule.has(subject)) latestRule.set(subject, entry.rule);
  }
  const workOf = (kind: "bill" | "milestone", row: WorkRow): ProjectWork => {
    const rule = row.status === "held" ? latestRule.get(row.id) : undefined;
    return {
      kind,
      id: row.id,
      label: kind === "bill" ? row.memo?.trim() || "Bill" : (row.title ?? "Milestone"),
      counterpartyName: row.counterparties?.name ?? "",
      amountMinor: obligationMinor(row.amount),
      status: row.status,
      state: workState(kind, row.status, reserved.has(row.id)),
      heldForBudget: rule === PROJECT_BUDGET_RULE,
      heldAsSameWork: rule === SAME_WORK_RULE,
      dueOn: kind === "bill" && row.due_date ? row.due_date.slice(0, 10) : null,
    };
  };
  const work = [
    ...((bills.data ?? []) as unknown as WorkRow[]).map((row) => workOf("bill", row)),
    ...((milestones.data ?? []) as unknown as WorkRow[]).map((row) => workOf("milestone", row)),
  ];

  const deals = await projectDeals(orgDb, projectId, now);
  const candidates = await readCandidates(orgDb);
  const setAsideAllMinor = all.projects.reduce((sum, entry) => sum + entry.figures.reservedMinor, 0);
  return { available: true, detail: { summary, setAsideAllMinor, work, deals, candidates } };
}

async function projectDeals(orgDb: OrgDb, projectId: string, now: Date): Promise<ProjectDeal[]> {
  const members = await orgDb.from("deals").select("id").eq("project_id", projectId);
  if (members.error) throw new Error(members.error.message);
  const ids = new Set(((members.data ?? []) as Array<{ id: string }>).map((row) => row.id));
  if (ids.size === 0) return [];
  const read = await readDeals(orgDb);
  if (!read.available) return [];
  const deals = read.deals.filter((deal) => ids.has(deal.facts.id));
  const collected = await readDealCollections(deals, now.toISOString().slice(0, 10), orgDb).catch((error: unknown) => {
    console.error("project: deal collections not read", error instanceof Error ? error.message : error);
    return null;
  });
  return deals.map((deal) => ({
    id: deal.facts.id,
    title: deal.title,
    customer: deal.customer.name,
    currency: deal.facts.currency,
    digits: deal.digits,
    totalMinor: deal.facts.totalMinor,
    collectedMinor: collected?.get(deal.facts.id)?.collection.collectedMinor ?? null,
  }));
}

/** Open bills in USDC, open milestones and deals in no project, newest first: what the page offers to add. */
async function readCandidates(orgDb: OrgDb): Promise<ProjectCandidate[]> {
  const [bills, milestones, deals] = await Promise.all([
    orgDb
      .from("invoices")
      .select("id, amount, memo, counterparties(name)")
      .eq("direction", "payable")
      .eq("currency", "USDC")
      .is("project_id", null)
      .not("status", "in", "(paid,rejected,matched,processing)")
      .order("created_at", { ascending: false })
      .limit(CANDIDATES_READ),
    orgDb
      .from("milestones")
      .select("id, amount, title, counterparties(name)")
      .is("project_id", null)
      .not("status", "in", "(paid,closed)")
      .order("created_at", { ascending: false })
      .limit(CANDIDATES_READ),
    orgDb.from("deals").select("id, title, counterparties(name)").is("project_id", null).order("created_at", { ascending: false }).limit(CANDIDATES_READ),
  ]);
  for (const read of [bills, milestones, deals]) if (read.error) throw new Error(read.error.message);
  type Row = { id: string; amount?: string | number; memo?: string | null; title?: string; counterparties: { name: string } | null };
  const name = (row: Row) => row.counterparties?.name ?? "";
  return [
    ...((bills.data ?? []) as unknown as Row[]).map((row) => ({ kind: "bill" as const, id: row.id, label: `${name(row)}: ${row.memo?.trim() || "bill"}, ${Number(row.amount)} USDC` })),
    ...((milestones.data ?? []) as unknown as Row[]).map((row) => ({ kind: "milestone" as const, id: row.id, label: `${name(row)}: ${row.title}, ${Number(row.amount)} USDC` })),
    ...((deals.data ?? []) as unknown as Row[]).map((row) => ({ kind: "deal" as const, id: row.id, label: `${name(row)}: ${row.title}` })),
  ];
}
