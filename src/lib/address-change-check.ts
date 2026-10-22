import crypto from "node:crypto";
import type { AddressChangeVia, AddressCheckStatus } from "./address-change-check-words";
import { can } from "./auth/roles";
import { simulatesPayments } from "./capability-read";
import { db, platformDb, unwrap, type OrgDb } from "./dal";
import { withOrg } from "./dal/scope";
import { addressChangeCheckEmail } from "./email/address-change-check";
import { addressChangeDisputedEmail } from "./email/address-change-disputed";
import { sendEmail } from "./email/send";
import { appendLedgerEntry } from "./ledger";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";
import { listMembers } from "./platform/members";
import { publicOrigin } from "./public-origin";
import { readShadowMode } from "./shadow-mode";
import { recordUsageFor } from "./usage/record";

export * from "./address-change-check-words";

/**
 * "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md): when a payee's address changes
 * to a new one, its billing email on file is asked by email whether they made the change; "No, this wasn't me"
 * freezes the payee until an owner or admin unfreezes it.
 *
 * Asking never throws and never undoes the change it asks about (AC1). Every read of what migration 0137 adds treats its
 * absence as none: before it runs, nothing is asked and nothing is frozen.
 */

/** How long a check's link answers (AC2). */
export const CHECK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Enough for any workspace's owners and admins; a bound so one answer never fans out without limit. */
const MAX_RECIPIENTS = 10;

const TOKEN = /^vxw_([A-Za-z0-9_-]{43})$/;

const sha256hex = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

/** A new link's token and the hash kept of it: `vxw_` and 32 random bytes, base64url. */
export function generateCheckToken(random: (n: number) => Buffer = crypto.randomBytes): { token: string; tokenHash: string } {
  const secret = random(32).toString("base64url");
  return { token: `vxw_${secret}`, tokenHash: sha256hex(secret) };
}

/** The hash a token is looked up by, or null for anything that is not one. */
export function checkTokenHash(token: string): string | null {
  const match = TOKEN.exec(token);
  return match ? sha256hex(match[1]) : null;
}

export function checkUrl(origin: string, token: string): string {
  return `${origin}/address-change/${token}`;
}

/** Postgres's or PostgREST's "no such table, column or function": migration 0137 has not run here yet. */
export function beforeChecks(error: { code?: string | null } | null | undefined): boolean {
  return ["42P01", "42703", "42883", "PGRST202", "PGRST204", "PGRST205"].includes(error?.code ?? "");
}

export type AskOutcome = "asked" | "not_sent" | "not_asked";

/**
 * The payee's address before `to`, from its signed entries, newest first: what a change, or its creation, set before. Null
 * for a payee that never had one. So clearing an address and then setting a new one still asks (AC1).
 */
async function earlierAddress(counterpartyId: string, to: string): Promise<string | null> {
  const rows = unwrap(
    await db()
      .from("ledger_entries")
      .select("action, detail")
      .in("action", ["create_counterparty", "counterparty_address_changed"])
      .eq("detail->>counterpartyId", counterpartyId)
      .order("seq", { ascending: false })
      .limit(50)
  ) as Array<{ action: string; detail: Record<string, unknown> }>;
  for (const row of rows) {
    const earlier = row.action === "create_counterparty" ? row.detail.address : row.detail.from;
    if (typeof earlier === "string" && /^0x[0-9a-fA-F]{40}$/.test(earlier) && earlier.toLowerCase() !== to.toLowerCase()) return earlier;
  }
  return null;
}

/**
 * Asks the payee's billing email whether they changed its address (AC1, AC2), in the workspace `orgId`. For a change to a
 * new address, from one before it (the one on file, or one cleared earlier), in a live workspace that is not in shadow
 * mode, with a notice email on file. Never throws: a failure is logged, and the change waits for a member's confirmation
 * as before.
 */
export async function askContactAboutAddressChange(input: {
  orgId: string;
  counterpartyId: string;
  from: string | null;
  to: string | null;
  via: AddressChangeVia;
  githubLogin?: string | null;
  /** The member whose edit changed it, when one did (AC4). */
  changedBy?: string | null;
  now?: number;
}): Promise<AskOutcome> {
  if (!input.to) return "not_asked";
  const to = input.to;
  try {
    return await withOrg(input.orgId, async () => {
      const org = unwrap(await platformDb().from("orgs").select("name, mode").eq("id", input.orgId).single()) as { name: string; mode: "sandbox" | "live" };
      if (simulatesPayments(org.mode)) return "not_asked";
      // In shadow mode the business still pays its suppliers its own way: their addresses are for test USDC.
      if (await readShadowMode(db())) return "not_asked";
      const payee = unwrap(await db().from("counterparties").select("name, notice_email").eq("id", input.counterpartyId).single()) as {
        name: string;
        notice_email: string | null;
      };
      if (!payee.notice_email) return "not_asked";
      const from = input.from ?? (await earlierAddress(input.counterpartyId, to));
      if (!from) return "not_asked";

      const now = input.now ?? Date.now();
      const { token, tokenHash } = generateCheckToken();
      const made = await platformDb().rpc("create_address_change_check", {
        p_org_id: input.orgId,
        p_counterparty_id: input.counterpartyId,
        p_from: from,
        p_to: to,
        p_via: input.via,
        p_github_login: input.githubLogin ?? null,
        p_changed_by: input.changedBy ?? null,
        p_sent_to: payee.notice_email,
        p_token_hash: tokenHash,
        p_expires_at: new Date(now + CHECK_TTL_MS).toISOString(),
      });
      if (made.error) {
        if (beforeChecks(made.error)) return "not_asked";
        throw new Error(made.error.message);
      }
      // Asked late, after the address changed again: the newer change's own check stands.
      const check = made.data as { id: string | null; created_at: string; expires_at: string } | null;
      if (!check?.id) return "not_asked";

      const origin = publicOrigin();
      const email = addressChangeCheckEmail({
        orgName: org.name,
        payeeName: payee.name,
        from,
        to,
        via: input.via,
        githubLogin: input.githubLogin ?? null,
        changedAt: check.created_at,
        link: checkUrl(origin, token),
        expiresAt: new Date(check.expires_at),
        origin,
      });
      const sent = await sendEmail({ to: payee.notice_email, ...email, meter: "address_change_check" });
      if (!sent.sent) {
        console.error("address change check: email not sent", sent.reason);
        return "not_sent";
      }
      const marked = await platformDb().rpc("mark_address_change_check_sent", { p_check_id: check.id });
      if (marked.error) console.error("address change check: not marked sent", check.id);
      await appendLedgerEntryBestEffort(input.orgId, {
        actor: "system",
        domain: "compliance",
        action: "address_change_check_sent",
        summary: `Asked ${payee.name}'s contact on file whether they changed their payment address`,
        // The contact is named by where it came from, never by its address.
        detail: { counterpartyId: input.counterpartyId, checkId: check.id, from, to, via: input.via, contact: "notice_email" },
      });
      return "asked";
    });
  } catch (error) {
    console.error("address change check: not asked", error instanceof Error ? error.message : "unknown error");
    return "not_asked";
  }
}

export interface AddressChangePreview {
  orgName: string;
  payeeName: string;
  from: string;
  to: string;
  via: AddressChangeVia;
  githubLogin: string | null;
  changedAt: string;
  expiresAt: string;
}

/** What the payee's page shows (AC3), for an open, unexpired check; null for any other link. Reading changes nothing. */
export async function previewAddressChange(token: string): Promise<AddressChangePreview | null> {
  const tokenHash = checkTokenHash(token);
  if (!tokenHash) return null;
  const read = await platformDb().rpc("address_change_check_preview", { p_token_hash: tokenHash });
  if (read.error) {
    if (beforeChecks(read.error)) return null;
    throw new Error(read.error.message);
  }
  const row = ((read.data ?? []) as Array<{
    org_name: string;
    counterparty_name: string;
    from_address: string;
    to_address: string;
    via: AddressChangeVia;
    github_login: string | null;
    created_at: string;
    expires_at: string;
  }>)[0];
  if (!row) return null;
  return {
    orgName: row.org_name,
    payeeName: row.counterparty_name,
    from: row.from_address,
    to: row.to_address,
    via: row.via,
    githubLogin: row.github_login,
    changedAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** The payee's answer: "confirmed" for yes, "frozen" or "disputed" for not me, "not_valid" for a link that answers nothing. */
export type AnswerOutcome = "confirmed" | "frozen" | "disputed" | "not_valid";

/**
 * Takes the payee's answer, once (AC3). Yes is recorded and confirms nothing. Not me freezes the payee, in the same step,
 * while the address in question is still on file, and the owners and admins are told by email: through `defer`, after
 * the payee has its page, when the caller gives one.
 */
export async function answerAddressChange(
  token: string,
  notMe: boolean,
  options: { defer?: (work: () => Promise<unknown>) => void } = {}
): Promise<AnswerOutcome> {
  const tokenHash = checkTokenHash(token);
  if (!tokenHash) return "not_valid";
  const done = await platformDb().rpc("answer_address_change_check", { p_token_hash: tokenHash, p_not_me: notMe });
  if (done.error) {
    if (beforeChecks(done.error)) return "not_valid";
    throw new Error(done.error.message);
  }
  const row = ((done.data ?? []) as Array<{
    outcome: AnswerOutcome;
    check_id: string | null;
    org_id: string | null;
    counterparty_id: string | null;
    from_address: string | null;
    to_address: string | null;
    org_name: string | null;
    org_slug: string | null;
    counterparty_name: string | null;
  }>)[0];
  if (!row || row.outcome === "not_valid" || !row.org_id || !row.counterparty_id) return "not_valid";
  const { org_id: orgId, counterparty_id: counterpartyId, check_id: checkId, from_address: from, to_address: to } = row;
  const payeeName = row.counterparty_name ?? "A payee";

  // The answer is taken by now: what follows is recorded and told, and never undoes it.
  await withOrg(orgId, async () => {
    // The payee answered through its link: no member did, so `by` is null (as a payee link's address).
    await appendLedgerEntryBestEffort(orgId, {
      actor: "human",
      domain: "compliance",
      action: "address_change_answered",
      summary: notMe
        ? `${payeeName}'s contact on file said they did not make the change to their payment address`
        : `${payeeName}'s contact on file said they made the change to their payment address`,
      detail: { by: null, via: "address_check", counterpartyId, checkId, answer: notMe ? "not_me" : "me", from, to },
    });
    if (row.outcome === "frozen") {
      await appendLedgerEntryBestEffort(orgId, {
        actor: "system",
        domain: "compliance",
        action: "counterparty_frozen",
        summary: `Froze ${payeeName}: no one can confirm its address until an owner or admin unfreezes it`,
        detail: { counterpartyId, checkId, address: to, reason: "address_change_disputed" },
      });
    }
  }).catch((error: unknown) => {
    console.error("address change answer: not recorded", error instanceof Error ? error.message : "unknown error");
  });
  if (notMe && to && row.org_slug) {
    const work = () => notifyDisputed({ orgId, orgName: row.org_name ?? "Your workspace", slug: row.org_slug as string, payeeName, to, frozen: row.outcome === "frozen" });
    if (options.defer) {
      try {
        options.defer(work);
      } catch {
        await work();
      }
    } else await work();
  }
  return row.outcome;
}

/** Tells the owners and admins that a payee disputed an address change (AC3). Best effort: never throws. */
async function notifyDisputed(input: { orgId: string; orgName: string; slug: string; payeeName: string; to: string; frozen: boolean }): Promise<number> {
  try {
    const recipients = (await listMembers(input.orgId)).filter((member) => can(member.role, "records.write")).slice(0, MAX_RECIPIENTS);
    const origin = publicOrigin();
    const email = addressChangeDisputedEmail({
      orgName: input.orgName,
      payeeName: input.payeeName,
      to: input.to,
      frozen: input.frozen,
      link: `${origin}/o/${input.slug}/counterparties`,
      origin,
    });
    const results = await Promise.allSettled(recipients.map((member) => sendEmail({ to: member.email, ...email })));
    const sent = results.filter((result) => result.status === "fulfilled" && result.value.sent).length;
    if (sent < results.length) console.error("address change disputed: not every email sent");
    // Sent outside the workspace's scope, so metered into it here.
    if (sent > 0) await recordUsageFor(input.orgId, { kind: "email", action: "address_change_disputed", provider: "resend", quantity: sent });
    if (sent < results.length) await recordUsageFor(input.orgId, { kind: "email", action: "address_change_disputed", provider: "resend", quantity: results.length - sent, ok: false });
    return sent;
  } catch (error) {
    console.error("address change disputed: owners not told", error instanceof Error ? error.message : "unknown error");
    return 0;
  }
}

/** Why an unfreeze was refused (AC4). */
export class UnfreezeError extends Error {
  constructor(readonly code: "forbidden" | "note" | "not_frozen" | "changer") {
    super(
      code === "forbidden"
        ? "Only an owner or admin can unfreeze a payee."
        : code === "note"
          ? "Say how you checked with the payee, in a few words."
          : code === "changer"
            ? "You made the change this payee disputed, so another owner or admin unfreezes it."
            : "This payee is not frozen."
    );
    this.name = "UnfreezeError";
  }
}

/**
 * An owner or admin unfreezes a payee once they have checked with it (AC4), saying how. Whoever made the disputed change
 * does not, while another owner or admin can. The unfreeze is signed with the note, or put back: no unfreeze stands
 * unrecorded. The address still needs confirming afterwards. Runs in the workspace in scope.
 */
export async function unfreezeCounterparty(input: {
  orgId: string;
  actorId: string;
  role: Parameters<typeof can>[0];
  counterpartyId: string;
  note: string;
}): Promise<void> {
  if (!can(input.role, "records.write")) throw new UnfreezeError("forbidden");
  const note = input.note.trim();
  if (note.length < 3 || note.length > 500) throw new UnfreezeError("note");
  const read = await db().from("counterparties").select("name, frozen_check_id").eq("id", input.counterpartyId).maybeSingle();
  if (read.error) {
    if (beforeChecks(read.error)) throw new UnfreezeError("not_frozen");
    throw new Error(read.error.message);
  }
  const payee = read.data as { name: string; frozen_check_id: string | null } | null;
  if (payee?.frozen_check_id) {
    const check = unwrap(await db().from("address_change_checks").select("changed_by").eq("id", payee.frozen_check_id).maybeSingle()) as { changed_by: string | null } | null;
    if (check?.changed_by === input.actorId) {
      const others = (await listMembers(input.orgId)).filter((member) => member.userId !== input.actorId && can(member.role, "records.write"));
      if (others.length > 0) throw new UnfreezeError("changer");
    }
  }
  const done = await platformDb().rpc("unfreeze_counterparty", { p_org_id: input.orgId, p_counterparty_id: input.counterpartyId });
  if (done.error) {
    if (beforeChecks(done.error)) throw new UnfreezeError("not_frozen");
    throw new Error(done.error.message);
  }
  const cleared = ((done.data ?? []) as Array<{ frozen_at: string; frozen_check_id: string | null }>)[0];
  if (!cleared) throw new UnfreezeError("not_frozen");
  try {
    await appendLedgerEntry({
      actor: "human",
      domain: "compliance",
      action: "counterparty_unfrozen",
      summary: `Unfroze ${payee?.name ?? "a payee"}; its address still needs confirming`,
      detail: { by: input.actorId, counterpartyId: input.counterpartyId, checkId: cleared.frozen_check_id, note },
    });
  } catch (error) {
    const restored = await platformDb().rpc("restore_counterparty_freeze", {
      p_org_id: input.orgId,
      p_counterparty_id: input.counterpartyId,
      p_frozen_at: cleared.frozen_at,
      p_check_id: cleared.frozen_check_id,
    });
    // Left unfrozen with no entry: said by id alone.
    if (restored.error || restored.data !== true) console.error("unfreeze not put back", input.orgId, input.counterpartyId);
    throw error;
  }
}

/** A payee's freeze and its latest check that went out, as Counterparties and Approvals show them (AC5). */
export interface AddressCheckView {
  frozen: boolean;
  /** `expired`: its link no longer answers, read when the view is. */
  check: { status: AddressCheckStatus; sentAt: string | null; createdAt: string; expired: boolean; to: string } | null;
}

/**
 * The freeze and the latest check sent for each of `counterpartyIds`, in the workspace in scope. Before migration 0137,
 * none: an empty map.
 */
export async function readAddressChecks(counterpartyIds: string[], orgDb: OrgDb = db(), now: number = Date.now()): Promise<Map<string, AddressCheckView>> {
  const views = new Map<string, AddressCheckView>();
  if (counterpartyIds.length === 0) return views;
  for (let start = 0; start < counterpartyIds.length; start += 100) {
    const chunk = counterpartyIds.slice(start, start + 100);
    const [frozen, checks] = await Promise.all([
      orgDb.from("counterparties").select("id, frozen_at").in("id", chunk).not("frozen_at", "is", null),
      orgDb
        .from("address_change_checks")
        .select("counterparty_id, status, sent_at, created_at, expires_at, to_address")
        .in("counterparty_id", chunk)
        .neq("status", "replaced")
        .not("sent_at", "is", null)
        .order("created_at", { ascending: false }),
    ]);
    if (frozen.error && !beforeChecks(frozen.error)) throw new Error(frozen.error.message);
    if (checks.error && !beforeChecks(checks.error)) throw new Error(checks.error.message);
    const frozenRows = Array.isArray(frozen.data) && !frozen.error ? (frozen.data as Array<{ id: string }>) : [];
    const checkRows =
      Array.isArray(checks.data) && !checks.error
        ? (checks.data as Array<{ counterparty_id: string; status: AddressCheckStatus; sent_at: string | null; created_at: string; expires_at: string; to_address: string }>)
        : [];
    for (const row of frozenRows) views.set(row.id, { frozen: true, check: null });
    for (const row of checkRows) {
      const view = views.get(row.counterparty_id) ?? { frozen: false, check: null };
      // Newest first: the first row per payee is its latest.
      if (view.check) continue;
      views.set(row.counterparty_id, {
        ...view,
        check: { status: row.status, sentAt: row.sent_at, createdAt: row.created_at, expired: Date.parse(row.expires_at) <= now, to: row.to_address },
      });
    }
  }
  return views;
}

/** Which of `counterpartyIds` are frozen (AC5), in the workspace in scope: none before migration 0137. */
export async function readFrozenPayees(counterpartyIds: string[], orgDb: OrgDb = db()): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < counterpartyIds.length; start += 100) {
    const read = await orgDb.from("counterparties").select("id").in("id", counterpartyIds.slice(start, start + 100)).not("frozen_at", "is", null);
    if (read.error) {
      if (beforeChecks(read.error)) return found;
      throw new Error(read.error.message);
    }
    for (const row of Array.isArray(read.data) ? (read.data as Array<{ id: string }>) : []) found.add(row.id);
  }
  return found;
}

/** Why no approval pays a frozen payee (AC3), as Approve and pay and Pay now say it. */
export function frozenRefusal(payeeName: string): string {
  return `${payeeName} is frozen: their contact on file said they did not make the change to its address. An owner or admin unfreezes it on Counterparties after checking with them.`;
}

/** Whether a payee is frozen (AC3); false before migration 0137. A read that fails otherwise throws: nothing is confirmed on a guess. */
export async function counterpartyFrozen(counterpartyId: string, orgDb: OrgDb = db()): Promise<boolean> {
  const read = await orgDb.from("counterparties").select("frozen_at").eq("id", counterpartyId).maybeSingle();
  if (read.error) {
    if (beforeChecks(read.error)) return false;
    throw new Error(read.error.message);
  }
  return Boolean((read.data as { frozen_at?: string | null } | null)?.frozen_at);
}
