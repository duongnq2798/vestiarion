import crypto from "node:crypto";
import { runCycleSoon } from "../agent/cycle-soon";
import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { MAX_TERM_DAYS, MIN_TERM_DAYS, TERM_REQUEST_TTL_MS } from "./rules";

/**
 * Asking suppliers for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md): when a bill is held for want
 * of cash, the agent emails the supplier a one-time link asking to pay the same amount on a later day; a supplier who
 * agrees moves the due date, and a cycle starts at once to decide the bill again.
 *
 * A token is `vxt_` and 43 base64url characters (32 random bytes). Only the SHA-256 of the secret is kept (0128).
 */

const TOKEN = /^vxt_([A-Za-z0-9_-]{43})$/;
const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

export class TermRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermRequestError";
  }
}

export function generateTermToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; secretHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxt_${secret}`, secretHash: sha256hex(secret) };
}

/** The stored hash for a well-formed token; null for anything else, which is never looked up. */
export function termTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

export function termUrl(origin: string, token: string): string {
  return `${origin}/more-time/${token}`;
}

export interface MadeTermRequest {
  id: string;
  invoice_id: string;
  counterparty_id: string;
  days: number;
  amount: string;
  due_date: string;
  new_due_date: string;
  currency: string;
  expires_at: string;
}

/** A request the agent makes (X4): the row and its link, which the agent emails at once; the stage records it. */
export async function createTermRequest(input: { orgId: string; invoiceId: string; days: number; origin: string; now?: number }): Promise<{ url: string; row: MadeTermRequest }> {
  const { token, secretHash } = generateTermToken();
  const expires = new Date((input.now ?? Date.now()) + TERM_REQUEST_TTL_MS).toISOString();
  const made = await platformDb()
    .rpc("create_term_request", { p_org_id: input.orgId, p_invoice_id: input.invoiceId, p_days: input.days, p_token_hash: secretHash, p_expires_at: expires })
    .select("id, invoice_id, counterparty_id, days, amount, due_date, new_due_date, currency, expires_at")
    .single<MadeTermRequest>();
  if (made.error) {
    if (/^term_request_not_eligible/.test(made.error.message)) throw new TermRequestError("This bill can no longer take a request for more time.");
    throw new Error(made.error.message);
  }
  return { url: termUrl(input.origin, token), row: made.data };
}

/** A request whose email did not go (X6), withdrawn so its link never stands unseen; false when it was not open. */
export async function withdrawTermRequest(orgId: string, requestId: string): Promise<boolean> {
  const done = await platformDb().rpc("withdraw_term_request", { p_org_id: orgId, p_request_id: requestId });
  if (done.error) throw new Error(done.error.message);
  return done.data === true;
}

export interface TermRequestPreview {
  orgName: string;
  counterpartyName: string;
  reference: string | null;
  amount: number;
  currency: string;
  dueDate: string;
  newDueDate: string;
  days: number;
  expiresAt: string;
}

/** What the supplier's page shows (X4); null for a token that is not an open request. */
export async function previewTermRequest(token: string): Promise<TermRequestPreview | null> {
  const tokenHash = termTokenHash(token);
  if (!tokenHash) return null;
  const read = await platformDb().rpc("term_request_preview", { p_token_hash: tokenHash });
  if (read.error) throw new Error(read.error.message);
  const row = ((read.data ?? []) as Array<{ org_name: string; counterparty_name: string; memo: string | null; amount: string; currency: string; due_date: string; new_due_date: string; days: number; expires_at: string }>)[0];
  if (!row) return null;
  return {
    orgName: row.org_name,
    counterpartyName: row.counterparty_name,
    reference: row.memo,
    amount: Number(row.amount),
    currency: row.currency,
    dueDate: row.due_date,
    newDueDate: row.new_due_date,
    days: Number(row.days),
    expiresAt: row.expires_at,
  };
}

export type TermDecisionOutcome = "accepted" | "declined" | "bill_changed" | "not_valid";

/**
 * The supplier's answer (X5), in one database step. Agreed, the bill's due date moves and the bill returns to the agent,
 * the ledger records it in the workspace, and a cycle starts at once to decide it again.
 */
export async function decideTermRequest(token: string, accept: boolean, deps: { raise?: typeof runCycleSoon } = {}): Promise<TermDecisionOutcome> {
  const tokenHash = termTokenHash(token);
  if (!tokenHash) return "not_valid";
  const done = await platformDb().rpc("decide_term_request", { p_token_hash: tokenHash, p_accept: accept });
  if (done.error) throw new Error(done.error.message);
  const row = ((done.data ?? []) as Array<{ outcome: TermDecisionOutcome; request_id: string | null; org_id: string | null; invoice_id: string | null; days: number | null; new_due_date: string | null }>)[0];
  if (!row || !row.org_id || (row.outcome !== "accepted" && row.outcome !== "declined")) return row?.outcome ?? "not_valid";
  const orgId = row.org_id;
  const org = unwrap(await platformDb().from("orgs").select("mode").eq("id", orgId).single()) as { mode: "sandbox" | "live" };
  await withOrg(orgId, async () => {
    await appendLedgerEntryBestEffort(orgId, {
      actor: "system",
      domain: "ap",
      action: row.outcome === "accepted" ? "term_request_accepted" : "term_request_declined",
      summary: row.outcome === "accepted" ? `The supplier agreed to ${row.days} more days: the bill now falls due ${row.new_due_date?.slice(0, 10)}` : "The supplier declined the request for more time",
      detail: { requestId: row.request_id, invoiceId: row.invoice_id, ...(row.outcome === "accepted" ? { days: row.days, newDueDate: row.new_due_date } : {}), via: "terms_link" },
    });
  });
  if (row.outcome === "accepted") (deps.raise ?? runCycleSoon)({ orgId, sandbox: org.mode === "sandbox", kind: "term_request_accepted" });
  return row.outcome;
}

/** Whether the agent asks for more time in the workspace in scope, and its most days (X1); null before migration 0128. */
export async function termRequestsSetting(): Promise<{ on: boolean; maxDays: number | null; sandbox: boolean } | null> {
  const org = await platformDb()
    .from("orgs")
    .select("mode, term_requests_on_at, term_requests_max_days")
    .eq("id", currentOrgId())
    .maybeSingle<{ mode: string; term_requests_on_at: string | null; term_requests_max_days: number | null }>();
  if (org.error || !org.data) return null;
  return { on: org.data.term_requests_on_at !== null, maxDays: org.data.term_requests_max_days, sandbox: org.data.mode === "sandbox" };
}

/** The agent's requests turned on, with the most days it asks for, or off (X1); recorded in the ledger. */
export async function setTermRequests(input: { orgId: string; actorId: string; on: boolean; maxDays: number | null }): Promise<void> {
  if (input.on && (input.maxDays === null || !Number.isInteger(input.maxDays) || input.maxDays < MIN_TERM_DAYS || input.maxDays > MAX_TERM_DAYS)) {
    throw new TermRequestError(`Set the most days to ask for, from ${MIN_TERM_DAYS} to ${MAX_TERM_DAYS}.`);
  }
  const done = await platformDb().rpc("set_term_requests", { p_org_id: input.orgId, p_on: input.on, p_max_days: input.on ? input.maxDays : null, p_by: input.actorId });
  if (done.error) throw new Error(done.error.message);
  await appendLedgerEntryBestEffort(input.orgId, {
    actor: "human",
    domain: "ap",
    action: input.on ? "term_requests_on" : "term_requests_off",
    summary: input.on ? `The agent asks suppliers for up to ${input.maxDays} more days when cash is short` : "The agent no longer asks suppliers for more time",
    detail: { by: input.actorId, ...(input.on ? { maxDays: input.maxDays } : {}) },
  });
}

export interface TermRequestsView {
  setting: { on: boolean; maxDays: number | null; sandbox: boolean };
  /** The last requests, newest first. */
  recent: Array<{ id: string; counterpartyName: string; days: number; newDueDate: string; status: string; decidedAt: string | null }>;
}

/** The setting and the last requests, for Bills; null before migration 0128. */
export async function termRequestsView(): Promise<TermRequestsView | null> {
  const setting = await termRequestsSetting();
  if (!setting) return null;
  const rows = await db().from("payment_term_requests").select("id, days, new_due_date, status, decided_at, counterparties(name)").order("created_at", { ascending: false }).limit(5);
  const recent = ((rows.error ? [] : rows.data) as unknown as Array<{ id: string; days: number; new_due_date: string; status: string; decided_at: string | null; counterparties: { name: string } | null }>).map((row) => ({
    id: row.id,
    counterpartyName: row.counterparties?.name ?? "A supplier",
    days: Number(row.days),
    newDueDate: row.new_due_date,
    status: row.status,
    decidedAt: row.decided_at,
  }));
  return { setting, recent };
}
