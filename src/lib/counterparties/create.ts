import type { z } from "zod";
import { screenCounterparty } from "../compliance";
import { db, unwrap } from "../dal";
import type { counterpartyInputSchema } from "../intake-validation";
import { appendLedgerEntry } from "../ledger";
import { maskEmail } from "../payment-notices";
import { chainOn } from "../payee-chains";
import { workspaceNetwork } from "../workspace-network";

/** A counterparty as the form's schema accepts it. */
export type CounterpartyInput = z.output<typeof counterpartyInputSchema>;

export interface CreatedCounterparty {
  id: string;
  name: string;
  /** Its first screening's verdict, or why screening could not finish: the counterparty is added either way. */
  screening: { riskLevel: string } | { error: string };
}

/**
 * Adds one counterparty: the row, its `create_counterparty` entry, and its first screening. The one way a counterparty
 * is added, from the console form, the write API (write API R2) or a bounty on a pull request (bounties B7). Runs inside the organization's scope.
 *
 * An address that arrives through the API is stored as a change waiting for a person (R3): `address_changed_at` is set
 * and nobody has confirmed it, so the agent holds every payment to it until an owner, admin or approver confirms it on
 * Counterparties, exactly as for an address a payee sent through a link. An address a person typed into the console is
 * theirs, and is not.
 */
export async function createCounterparty(input: {
  actorId: string | null;
  counterparty: CounterpartyInput;
  via?: "api" | "github";
  apiKeyId?: string;
  /** With `via: "github"`: the installation the comment came through, and the GitHub user who wrote it (bounties B11). */
  github?: { installationId: number; login: string };
  now?: () => string;
}): Promise<CreatedCounterparty> {
  const { actorId, counterparty, via, apiKeyId, github } = input;
  // The workspace's own chain when none is given; one its network does not pay on is refused here too (network threading P3).
  const chain = chainOn(workspaceNetwork().id, counterparty.chain).id;
  // An address that came from outside the console waits for a person, whatever brought it.
  const addressNeedsConfirmation = via !== undefined && counterparty.address !== null;

  const row = unwrap(
    await db()
      .from("counterparties")
      .insert({
        name: counterparty.name,
        role: counterparty.role,
        address: counterparty.address,
        chain,
        jurisdiction: counterparty.jurisdiction,
        baseline_payment_limit: counterparty.paymentLimit || null,
        payment_limit: null,
        notice_email: counterparty.noticeEmail,
        ...(addressNeedsConfirmation ? { address_changed_at: input.now?.() ?? new Date().toISOString() } : {}),
      })
      .select("id, name")
      .single<{ id: string; name: string }>()
  );

  await appendLedgerEntry({
    actor: "human",
    domain: "compliance",
    action: "create_counterparty",
    summary: `Added ${row.name} as a ${counterparty.role}`,
    detail: {
      by: actorId,
      counterpartyId: row.id,
      role: counterparty.role,
      chain,
      address: counterparty.address,
      jurisdiction: counterparty.jurisdiction,
      baselinePaymentLimit: counterparty.paymentLimit || null,
      // Masked: who is told of a payment, not their whole address (payment notices R1).
      noticeEmail: counterparty.noticeEmail ? maskEmail(counterparty.noticeEmail) : null,
      ...(via === "api" ? { via, apiKeyId, addressNeedsConfirmation } : {}),
      ...(via === "github" ? { via, installationId: github?.installationId, login: github?.login, addressNeedsConfirmation } : {}),
    },
  });

  try {
    const screening = await screenCounterparty(row.id);
    return { id: row.id, name: row.name, screening: { riskLevel: screening.riskLevel } };
  } catch (error) {
    return { id: row.id, name: row.name, screening: { error: error instanceof Error ? error.message : "provider unavailable" } };
  }
}
