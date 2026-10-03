import { siteOrigin } from "./auth/env";
import { currentOrgId } from "./context";
import { utcMinute } from "./copy";
import { db, platformDb, unwrap } from "./dal";
import { paymentNoticeEmail } from "./email/payment-notice";
import { emailSettingsFromEnv, sendEmail, type EmailMessage, type SendResult } from "./email/send";
import { appendLedgerEntryBestEffort } from "./ledger-best-effort";

/**
 * Payment notices (docs/superpowers/specs/2026-10-03-payment-notices-design.md): once a payment to a counterparty is
 * confirmed, its payee is emailed what was paid, what for and the transaction (R2). Live workspaces only, payments on
 * Arc testnet only (R3); each payment once, claimed before it is sent and released if the send fails, for three days
 * (R4); every notice sent recorded as `payment_notice_sent` (R6). Runs inside a workspace's scope: the cycle's
 * `notices` stage, and after a person's approval (R5).
 */

/** How long after a payment its notice is still tried. */
export const NOTICE_WINDOW_DAYS = 3;
/** The most notices one run sends: a cycle never waits on a long queue of emails. */
export const NOTICES_PER_RUN = 10;

/** An address with most of its name hidden, for the ledger: "li***@example.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const name = email.slice(0, at);
  return `${name.slice(0, Math.min(2, name.length))}***${email.slice(at)}`;
}

const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const ARC_TX = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;

interface DueIntent {
  id: string;
  source_type: string;
  source_id: string;
  amount: string | number;
  token: string | null;
  tx_hash: string | null;
  chain: string | null;
  destination: string | null;
  confirmed_at: string | null;
  payout_route: string | null;
}

/** One line of what the run did, as a cycle logs it. */
export interface NoticeLine {
  domain: string;
  message: string;
}

/** What a notice says the payment was for: the invoice's memo and purchase order, or the milestone's title. */
function invoiceWhat(memo: string | null, po: string | null): string | null {
  if (memo && po) return `${memo} (${po})`;
  return memo ?? (po ? `purchase order ${po}` : null);
}

/**
 * Sends the notices the workspace in scope owes (R2–R6). Quietly does nothing in a sandbox, without email configured,
 * or with nothing owed. Never throws for one notice: a failed send is logged, released and tried again later.
 */
export async function sendPaymentNotices(
  options: { now?: number; send?: (message: EmailMessage) => Promise<SendResult>; origin?: string } = {}
): Promise<NoticeLine[]> {
  const orgId = currentOrgId();
  const org = unwrap(await platformDb().from("orgs").select("name, mode").eq("id", orgId).single()) as { name: string; mode: string };
  // A sandbox simulates its payments: it never emails anyone about one (R3).
  if (org.mode !== "live") return [];
  const settings = options.send ? null : emailSettingsFromEnv();
  if (!options.send && !settings) return [];
  const send = options.send ?? ((message: EmailMessage) => sendEmail(message, settings));
  const now = options.now ?? Date.now();

  // Who wants notices at all, usually nobody: without them, no payment is read. The earliest time an address was set
  // bounds the payments worth reading (R7), so a busy workspace's older payments never crowd out a new one.
  const recipients = unwrap(
    await db().from("counterparties").select("id, name, notice_email, notice_email_set_at").not("notice_email", "is", null).not("notice_email_set_at", "is", null)
  ) as Array<{ id: string; name: string; notice_email: string | null; notice_email_set_at: string | null }>;
  if (recipients.length === 0) return [];
  const windowStart = now - NOTICE_WINDOW_DAYS * 86_400_000;
  const earliestSet = Math.min(...recipients.map((row) => Date.parse(row.notice_email_set_at as string)));
  const since = new Date(Math.max(windowStart, Number.isFinite(earliestSet) ? earliestSet : windowStart)).toISOString();

  const due = (unwrap(
    await db()
      .from("payment_intents")
      .select("id, source_type, source_id, amount, token, tx_hash, chain, destination, confirmed_at, payout_route")
      .eq("status", "confirmed")
      .eq("provider_mode", "live")
      .is("notice_sent_at", null)
      .gte("confirmed_at", since)
      // Newest first: what was just paid is told first, whatever came before it.
      .order("confirmed_at", { ascending: false })
      .limit(NOTICES_PER_RUN * 5)
  ) as DueIntent[])
    // Payments made on Arc testnet, with their transaction: a payout to another chain gets none yet (R3).
    .filter((intent) => (intent.chain ?? "ARC-TESTNET") === "ARC-TESTNET" && !intent.payout_route && /^0x[0-9a-fA-F]{64}$/.test(intent.tx_hash ?? ""));
  if (due.length === 0) return [];

  const invoiceIds = due.filter((intent) => intent.source_type === "invoice").map((intent) => intent.source_id);
  const milestoneIds = due.filter((intent) => intent.source_type === "milestone").map((intent) => intent.source_id);
  const [invoices, milestones] = await Promise.all([
    invoiceIds.length > 0
      ? db().from("invoices").select("id, counterparty_id, memo, po_reference, direction").in("id", invoiceIds)
      : Promise.resolve({ data: [], error: null }),
    milestoneIds.length > 0 ? db().from("milestones").select("id, contractor_id, title").in("id", milestoneIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const sources = new Map<string, { counterpartyId: string; what: string | null; domain: "ap" | "contractor"; key: "invoiceId" | "milestoneId" }>();
  for (const row of unwrap(invoices) as Array<{ id: string; counterparty_id: string; memo: string | null; po_reference: string | null; direction: string }>) {
    if (row.direction === "payable") sources.set(row.id, { counterpartyId: row.counterparty_id, what: invoiceWhat(row.memo, row.po_reference), domain: "ap", key: "invoiceId" });
  }
  for (const row of unwrap(milestones) as Array<{ id: string; contractor_id: string; title: string }>) {
    sources.set(row.id, { counterpartyId: row.contractor_id, what: row.title, domain: "contractor", key: "milestoneId" });
  }
  const counterparties = new Map(recipients.map((row) => [row.id, row]));

  const origin = options.origin ?? siteOrigin();
  const lines: NoticeLine[] = [];
  let sentCount = 0;
  for (const intent of due) {
    if (sentCount >= NOTICES_PER_RUN) break;
    const source = sources.get(intent.source_id);
    const payee = source ? counterparties.get(source.counterpartyId) : undefined;
    if (!source || !payee?.notice_email) continue;
    // Only a payment confirmed after the address was set: setting one never sends notices for older payments (R7).
    if (!payee.notice_email_set_at || Date.parse(intent.confirmed_at ?? "") < Date.parse(payee.notice_email_set_at)) continue;

    // Claimed before it is sent: two runs at once never send it twice (R4).
    const claimed = unwrap(
      await db().from("payment_intents").update({ notice_sent_at: new Date(now).toISOString() }).eq("id", intent.id).is("notice_sent_at", null).select("id")
    ) as Array<{ id: string }>;
    if (claimed.length === 0) continue;

    const token = intent.token === "EURC" ? "EURC" : "USDC";
    const amount = AMOUNT.format(Number(intent.amount));
    const email = paymentNoticeEmail({
      orgName: org.name,
      payeeName: payee.name,
      amount,
      token,
      what: source.what,
      address: intent.destination ?? "your address",
      paidAt: utcMinute(intent.confirmed_at ?? new Date(now).toISOString()),
      txUrl: ARC_TX(intent.tx_hash as string),
      origin,
    });
    let result: SendResult;
    try {
      result = await send({ to: payee.notice_email, ...email });
    } catch (error) {
      result = { sent: false, reason: error instanceof Error ? error.message : "send failed" };
    }
    if (!result.sent) {
      // Released, so the next run tries again within the window.
      await db().from("payment_intents").update({ notice_sent_at: null }).eq("id", intent.id);
      console.error("payment notice not sent", intent.id, result.reason);
      lines.push({ domain: source.domain, message: `Payment notice to ${payee.name} not sent (${result.reason}); tried again at the next cycle` });
      continue;
    }
    sentCount += 1;
    await appendLedgerEntryBestEffort(orgId, {
      actor: "system",
      domain: source.domain,
      action: "payment_notice_sent",
      summary: `Told ${payee.name} by email that ${amount} ${token} was paid`,
      detail: {
        [source.key]: intent.source_id,
        counterpartyId: source.counterpartyId,
        to: maskEmail(payee.notice_email),
        amount: Number(intent.amount),
        token,
        txHash: intent.tx_hash,
      },
    });
    lines.push({ domain: source.domain, message: `Told ${payee.name} by email: ${amount} ${token} paid` });
  }
  return lines;
}

/**
 * Sets, changes or clears a counterparty's billing email (R1), and records it with both addresses masked: a payee's
 * payment notices go to it, and a client's reminders, once a person turns them on (collections R8).
 */
export async function changeCounterpartyNoticeEmail(input: {
  actorId: string;
  counterpartyId: string;
  email: string | null;
}): Promise<{ name: string; email: string | null; role: string }> {
  const orgId = currentOrgId();
  const before = (await db().from("counterparties").select("id, name, role, notice_email").eq("id", input.counterpartyId).maybeSingle()).data as {
    id: string;
    name: string;
    role: string;
    notice_email: string | null;
  } | null;
  if (!before) throw new Error("Counterparty not found.");
  if ((before.notice_email ?? null) === input.email) return { name: before.name, email: input.email, role: before.role };
  unwrap(await db().from("counterparties").update({ notice_email: input.email }).eq("id", input.counterpartyId).select("id"));
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "compliance",
    action: "counterparty_notice_email_changed",
    summary: input.email ? `Billing email for ${before.name}: ${maskEmail(input.email)}` : `Billing email for ${before.name} removed`,
    detail: {
      by: input.actorId,
      counterpartyId: input.counterpartyId,
      from: before.notice_email ? maskEmail(before.notice_email) : null,
      to: input.email ? maskEmail(input.email) : null,
    },
  });
  return { name: before.name, email: input.email, role: before.role };
}
