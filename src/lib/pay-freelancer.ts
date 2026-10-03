import { z } from "zod";
import { screenCounterparty } from "./compliance";
import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import { payeeLinkEmail } from "./email/payee-link";
import { sendEmail } from "./email/send";
import { isHttpsLink, usdcAmountSchema } from "./intake-validation";
import { appendLedgerEntry } from "./ledger";
import { createPayeeLink } from "./platform/payee-links";
import { publicOrigin } from "./public-origin";

/**
 * Paying a freelancer in one step
 * (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md): what an
 * owner or admin would otherwise do in six, composed. Runs inside the
 * workspace's scope.
 *
 * The freelancer becomes a contractor whose payment limit is the amount (R3),
 * and is screened. The work becomes a milestone, verified by the person
 * setting the payment up (R1, R2). A payee link is made, and emailed when an
 * email is given (R7). The address the freelancer adds through it waits for a
 * member's confirmation like any other (R4), and a live agent does not try to
 * pay before there is one (R5). Every write is one the app already makes, so
 * the ledger gains no new action (R8).
 */

/** What the person verifying records as their note (R2). */
export const FREELANCER_VERIFICATION_NOTE = "Delivered work confirmed when the payment was set up";

const freelancerPaymentSchema = z.object({
  name: z.string().trim().min(2, "Give the freelancer's name, in at least 2 characters").max(160, "Keep the name to 160 characters"),
  email: z
    .string()
    .trim()
    .max(254, "That email address does not look right")
    .refine((value) => value === "" || z.email().safeParse(value).success, "That email address does not look right")
    .transform((value) => value || null),
  work: z.string().trim().min(3, "Say what was delivered, in at least 3 characters").max(160, "Keep what was delivered to 160 characters"),
  amount: usdcAmountSchema,
  evidence: z
    .string()
    .trim()
    .max(500, "Keep the link to the work to 500 characters")
    .refine((value) => value === "" || isHttpsLink(value), "The link to the work must start with https://")
    .transform((value) => value || null),
});

export type FreelancerPayment = z.infer<typeof freelancerPaymentSchema>;

export function parseFreelancerPayment(
  raw: Record<"name" | "email" | "work" | "amount" | "evidence", string>
): { ok: true; value: FreelancerPayment } | { ok: false; message: string } {
  const parsed = freelancerPaymentSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the payment details." };
  return { ok: true, value: parsed.data };
}

export interface FreelancerPaymentResult {
  counterpartyId: string;
  milestoneId: string;
  name: string;
  /** The payee link, shown once. */
  url: string;
  expiresAt: string;
  /** True when the link was emailed, false when sending failed, null when no email was given. */
  emailed: boolean | null;
  /** The screening verdict, or `incomplete` when the provider could not be reached. */
  screening: string;
}

export async function setUpFreelancerPayment(
  input: FreelancerPayment & { actorId: string; orgName: string; now?: Date }
): Promise<FreelancerPaymentResult> {
  const now = (input.now ?? new Date()).toISOString();

  const counterparty = unwrap(
    await db()
      .from("counterparties")
      .insert({
        name: input.name,
        role: "contractor",
        address: null,
        chain: "ARC-TESTNET",
        baseline_payment_limit: input.amount,
        payment_limit: null,
        // The email the link goes to is where they hear they were paid (payment notices R1).
        notice_email: input.email || null,
      })
      .select("id, name")
      .single<{ id: string; name: string }>()
  );
  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "create_counterparty",
    summary: `Added ${counterparty.name} as a contractor`,
    detail: {
      by: input.actorId,
      counterpartyId: counterparty.id,
      role: "contractor",
      chain: "ARC-TESTNET",
      address: null,
      jurisdiction: null,
      baselinePaymentLimit: input.amount,
    },
  });

  let screening = "incomplete";
  try {
    screening = (await screenCounterparty(counterparty.id)).riskLevel;
  } catch (error) {
    // Screened again by the next cycle's sweep, as any counterparty added while the provider was down.
    console.error("pay a freelancer: screening incomplete", error instanceof Error ? error.message : error);
  }

  const milestone = unwrap(
    await db()
      .from("milestones")
      .insert({
        contractor_id: counterparty.id,
        title: input.work,
        amount: input.amount,
        verification_source: input.evidence,
        verified: true,
        status: "verified",
        verification_method: "manual",
        verification_status: "verified",
        verification_checked_at: now,
        verified_at: now,
        verification_detail: { note: FREELANCER_VERIFICATION_NOTE },
      })
      .select("id")
      .single<{ id: string }>()
  );
  await appendLedgerEntry({
    actor: "human",
    domain: "contractor",
    action: "create_milestone",
    summary: `Added milestone “${input.work}” for ${counterparty.name}: ${input.amount} USDC`,
    detail: {
      by: input.actorId,
      milestoneId: milestone.id,
      counterpartyId: counterparty.id,
      counterpartyName: counterparty.name,
      amount: input.amount,
      verificationSource: input.evidence,
    },
  });
  await appendLedgerEntry({
    actor: "human",
    domain: "contractor",
    action: "verify_milestone_manual",
    summary: `Verified milestone “${input.work}” manually`,
    detail: {
      by: input.actorId,
      milestoneId: milestone.id,
      verificationSource: input.evidence,
      verificationMethod: "manual",
      previousVerified: false,
      verified: true,
      note: FREELANCER_VERIFICATION_NOTE,
    },
  });

  const { link, token } = await createPayeeLink({ orgId: currentOrgId(), actorId: input.actorId, counterpartyId: counterparty.id });
  const origin = publicOrigin();
  const url = `${origin}/payee/${token}`;

  let emailed: boolean | null = null;
  if (input.email) {
    const email = payeeLinkEmail({
      orgName: input.orgName,
      payeeName: counterparty.name,
      work: input.work,
      amount: input.amount,
      link: url,
      expiresAt: new Date(link.expiresAt),
      origin,
    });
    try {
      emailed = (await sendEmail({ to: input.email, ...email })).sent;
    } catch (error) {
      console.error("pay a freelancer: link not emailed", error instanceof Error ? error.message : error);
      emailed = false;
    }
  }

  return { counterpartyId: counterparty.id, milestoneId: milestone.id, name: counterparty.name, url, expiresAt: link.expiresAt, emailed, screening };
}
