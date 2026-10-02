import { changeCounterpartyLimit } from "./counterparty-limit";
import { db, unwrap } from "./dal";
import { appendLedgerEntry } from "./ledger";

/**
 * People deciding the agent's proposals (docs/superpowers/specs/2026-10-02-limit-proposals-design.md
 * R4, R5). Runs inside the workspace's scope; who may (`records.write`) is the action's check.
 * Accepting is an ordinary limit change, through the same code as editing the limit on
 * Counterparties: refused while a cycle runs, the current limit set from the counterparty's risk.
 */

export type ProposalErrorCode = "not_found" | "not_open" | "superseded";

const MESSAGES: Record<ProposalErrorCode, string> = {
  not_found: "That suggestion was not found.",
  not_open: "That suggestion has already been decided.",
  superseded: "This counterparty's limit changed since the agent suggested it, so the suggestion no longer applies.",
};

export class ProposalError extends Error {
  constructor(readonly code: ProposalErrorCode) {
    super(MESSAGES[code]);
    this.name = "ProposalError";
  }
}

export interface ProposalEvidence {
  invoiceId: string;
  amountUsdc: number;
  approvedAt: string;
  agentAction: string;
}

export interface ProposalView {
  id: string;
  counterpartyId: string;
  counterpartyName: string;
  fromLimit: number | null;
  toLimit: number;
  reasoning: string;
  evidence: ProposalEvidence[];
  createdAt: string;
}

interface Row {
  id: string;
  counterparty_id: string;
  from_limit: string | null;
  to_limit: string;
  reasoning: string;
  evidence: unknown;
  created_at: string;
  status: string;
  counterparties: { name: string; baseline_payment_limit: string | null } | null;
}

const COLUMNS = "id, counterparty_id, from_limit, to_limit, reasoning, evidence, created_at, status, counterparties(name, baseline_payment_limit)";

function view(row: Row): ProposalView {
  const evidence = Array.isArray(row.evidence) ? (row.evidence as Array<Record<string, unknown>>) : [];
  return {
    id: row.id,
    counterpartyId: row.counterparty_id,
    counterpartyName: row.counterparties?.name ?? "Unknown counterparty",
    fromLimit: row.from_limit === null ? null : Number(row.from_limit),
    toLimit: Number(row.to_limit),
    reasoning: row.reasoning,
    evidence: evidence.map((item) => ({
      invoiceId: String(item.invoiceId ?? ""),
      amountUsdc: Number(item.amountUsdc ?? 0),
      approvedAt: String(item.approvedAt ?? ""),
      agentAction: String(item.agentAction ?? ""),
    })),
    createdAt: row.created_at,
  };
}

/** The open proposals, newest first. */
export async function listOpenProposals(): Promise<ProposalView[]> {
  const rows = unwrap(await db().from("policy_proposals").select(COLUMNS).eq("status", "open").order("created_at", { ascending: false })) as unknown as Row[];
  return rows.map(view);
}

async function openProposal(id: string): Promise<Row> {
  const found = await db().from("policy_proposals").select(COLUMNS).eq("id", id).maybeSingle<Row>();
  if (found.error) throw new Error(found.error.message);
  if (!found.data) throw new ProposalError("not_found");
  if (found.data.status !== "open") throw new ProposalError("not_open");
  return found.data;
}

/** Closes an open proposal compare-and-set; false when someone else decided it first. */
async function close(id: string, status: "accepted" | "dismissed" | "superseded", actorId: string | null): Promise<boolean> {
  const rows = unwrap(
    await db().from("policy_proposals").update({ status, decided_at: new Date().toISOString(), decided_by: actorId }).eq("id", id).eq("status", "open").select("id")
  ) as Array<{ id: string }>;
  return rows.length > 0;
}

/** Accepts a proposal: the counterparty's limit becomes the proposed one, as a person's edit would make it (R4). */
export async function acceptProposal(input: { actorId: string; id: string }): Promise<{ counterpartyName: string; to: number; current: number | null }> {
  const proposal = await openProposal(input.id);
  const name = proposal.counterparties?.name ?? "a counterparty";
  const now = proposal.counterparties?.baseline_payment_limit;
  if (proposal.from_limit !== null && (now === null || now === undefined || Math.abs(Number(now) - Number(proposal.from_limit)) > 0.0000005)) {
    await close(proposal.id, "superseded", null);
    throw new ProposalError("superseded");
  }
  const changed = await changeCounterpartyLimit({ actorId: input.actorId, counterpartyId: proposal.counterparty_id, raw: String(Number(proposal.to_limit)) });
  if (!(await close(proposal.id, "accepted", input.actorId))) throw new ProposalError("not_open");
  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "policy_proposal_accepted",
    summary: `Accepted the agent's proposal: ${name}'s payment limit from ${changed.from ?? "none"} to ${changed.to} USDC`,
    detail: { by: input.actorId, proposalId: proposal.id, counterpartyId: proposal.counterparty_id, fromLimit: changed.from, toLimit: changed.to, currentLimit: changed.current },
  });
  return { counterpartyName: name, to: Number(changed.to), current: changed.current };
}

/** Dismisses a proposal: nothing changes, and the agent asks again only after a newer override (R2). */
export async function dismissProposal(input: { actorId: string; id: string }): Promise<{ counterpartyName: string }> {
  const proposal = await openProposal(input.id);
  if (!(await close(proposal.id, "dismissed", input.actorId))) throw new ProposalError("not_open");
  const name = proposal.counterparties?.name ?? "a counterparty";
  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "policy_proposal_dismissed",
    summary: `Dismissed the agent's proposal to raise ${name}'s payment limit to ${Number(proposal.to_limit)} USDC`,
    detail: { by: input.actorId, proposalId: proposal.id, counterpartyId: proposal.counterparty_id, toLimit: Number(proposal.to_limit) },
  });
  return { counterpartyName: name };
}
