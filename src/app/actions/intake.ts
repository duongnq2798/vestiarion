"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { cosignsNow } from "@/lib/approval-policy";
import { authorize } from "@/lib/auth/authorize";
import { can } from "@/lib/auth/roles";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import {
  counterpartyInputSchema,
  firstZodMessage,
  invoiceFormRefusal,
  invoiceInputSchema,
  noticeEmailSchema,
  type InvoiceField,
  counterpartyChainProblem,
  INVOICE_CURRENCIES,
} from "@/lib/intake-validation";
import { changeCounterpartyNoticeEmail } from "@/lib/payment-notices";
import { unfreezeCounterparty, UnfreezeError } from "@/lib/address-change-check";
import { addressProblem, ARC_ADDRESS } from "@/lib/address-checksum";
import { primaryName, resolveAddressName } from "@/lib/ens";
import { isAddressName, nameMatchesPayee } from "@/lib/ens-words";
import { takeAddressNameToken } from "@/lib/rate-limit";
import {
  changeCounterpartyAddress,
  confirmCounterpartyAddress,
  CounterpartyAddressError,
} from "@/lib/counterparty-address";
import { changeCounterpartyLimit, CounterpartyLimitError } from "@/lib/counterparty-limit";
import { limitApplied } from "@/lib/policy-replay-apply";
import { RuleReplayError } from "@/lib/policy-replay-read";
import { changeCounterpartyPurchaseOrders, CounterpartyPurchaseOrdersError } from "@/lib/counterparty-purchase-orders";
import { documentProvenance } from "@/lib/invoice-document/provenance";
import { createCounterparty } from "@/lib/counterparties/create";
import { createInvoice } from "@/lib/invoices/create";
import { consoleActor } from "@/lib/commands/actor";
import { assignToProjectCommand } from "@/lib/commands/projects";
import { workspaceNetwork } from "@/lib/workspace-network";
import { db } from "@/lib/dal";
import { coolingOffLabel, inCoolingOff, parseVerification, readPayeeLock } from "@/lib/payee-lock";
import { FxRateError } from "@/lib/fx/usd-rates";
import { shadowBill, ShadowBillError, type OriginalBill } from "@/lib/shadow-bills";

export interface IntakeActionResult {
  ok: boolean;
  message: string;
  created?: number;
  verdict?: string;
  /** The invoice form's refused fields, each with its first error, shown under the field. */
  fieldErrors?: Partial<Record<InvoiceField, string>>;
  /** Refused as a possible duplicate of a bill already in the workspace: the form then asks the person to say it is not one. */
  duplicate?: true;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function createCounterpartyAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = counterpartyInputSchema.safeParse({
      name: formString(formData, "name"),
      noticeEmail: formString(formData, "noticeEmail"),
      role: formString(formData, "role"),
      address: formString(formData, "address"),
      chain: formString(formData, "chain"),
      jurisdiction: formString(formData, "jurisdiction"),
      paymentLimit: formString(formData, "paymentLimit"),
    });
    if (!parsed.success) return { ok: false, message: firstZodMessage(parsed.error) };
    const chainProblem = counterpartyChainProblem(workspaceNetwork().id, parsed.data.chain);
    if (chainProblem) return { ok: false, message: chainProblem };
    // Asked in shadow mode, of a supplier: whether it sends purchase orders sets "Pay without purchase orders" (three-way
    // match design M2). Unanswered, the default stands.
    const answer = formString(formData, "purchaseOrders");
    const purchaseOrderRequired = parsed.data.role === "client" || (answer !== "yes" && answer !== "no") ? undefined : answer === "yes";

    try {
      // The one way a counterparty is added, shared with the write API (write API R2).
      const counterparty = await createCounterparty({ actorId: auth.user.id, counterparty: parsed.data, purchaseOrderRequired });
      revalidateOrgPages();
      if ("riskLevel" in counterparty.screening) {
        return {
          ok: true,
          created: 1,
          verdict: counterparty.screening.riskLevel,
          message: `${counterparty.name} added and screened: ${counterparty.screening.riskLevel} risk.`,
        };
      }
      return {
        ok: true,
        created: 1,
        verdict: "incomplete",
        message: `${counterparty.name} was added, but screening is incomplete: ${counterparty.screening.error}`,
      };
    } catch (error) {
      console.error("counterparty intake failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "Counterparty could not be added." };
    }
  });
}

const counterpartyIdSchema = z.string().uuid();

/**
 * A `CounterpartyAddressError`, `CounterpartyLimitError` or `CounterpartyPurchaseOrdersError` carries a message safe to
 * show; anything else stays in the server log.
 */
function addressFailure(error: unknown, what: string): IntakeActionResult {
  if (
    error instanceof CounterpartyAddressError ||
    error instanceof CounterpartyLimitError ||
    error instanceof CounterpartyPurchaseOrdersError ||
    error instanceof RuleReplayError
  ) {
    return { ok: false, message: error.message };
  }
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
}

/** What an address field's hint shows (ENS address names EN1, EN3). */
export interface AddressNameLookup {
  ok: boolean;
  message?: string;
  /** `name`: the field holds a name, and `address` is where it points (absent when nowhere). `address`: it holds an address, and `name` is its ENS name, if any. */
  kind?: "name" | "address";
  name?: string | null;
  address?: string;
  /** Whether the name looks like the payee's: false is a question to check, never a refusal. */
  matches?: boolean;
}

/**
 * Looks up the ENS name or Basename typed into an address field, or an address's ENS name (ENS address names EN1, EN3),
 * for whoever may add or change a payee. It reads Ethereum mainnet, and stores and signs nothing: the field saves an
 * address only.
 */
export async function lookupAddressNameAction(orgSlug: string, query: string, payeeName: string): Promise<AddressNameLookup> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  if (!takeAddressNameToken(auth.user.id)) return { ok: false, message: "Too many lookups at once. Wait a moment, or paste the address." };
  return inOrg(auth, async () => {
    const value = typeof query === "string" ? query.trim().slice(0, 255) : "";
    const payee = typeof payeeName === "string" ? payeeName.slice(0, 160) : "";
    try {
      if (isAddressName(value)) {
        const found = await resolveAddressName(value);
        if (!found) return { ok: true, kind: "name", name: value.toLowerCase() };
        return { ok: true, kind: "name", name: found.name, address: found.address, matches: payee ? nameMatchesPayee(found.name, payee) : true };
      }
      if (ARC_ADDRESS.test(value) && !addressProblem(value)) {
        const name = await primaryName(value);
        return { ok: true, kind: "address", name, matches: name && payee ? nameMatchesPayee(name, payee) : true };
      }
      return { ok: true };
    } catch (error) {
      console.error("address name lookup failed", error instanceof Error ? error.message.slice(0, 120) : "unknown error");
      return { ok: false, message: "The name could not be looked up. Try again, or paste the address." };
    }
  });
}

/** Sets, changes or clears a counterparty's Arc address. The next payment to a changed address waits for a person. */
export async function updateCounterpartyAddressAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    try {
      // The payee's contact is asked whether they made the change after this answer (address change check AC1).
      const result = await changeCounterpartyAddress({
        actorId: auth.user.id,
        counterpartyId: id.data,
        raw: formString(formData, "address"),
        defer: (work) => after(work),
      });
      revalidateOrgPages();
      return {
        ok: true,
        message:
          result.to === null
            ? `${result.name}'s address cleared.`
            : `${result.name}'s address changed. The next payment to it waits for a person to approve it.`,
      };
    } catch (error) {
      return addressFailure(error, "counterparty address change failed");
    }
  });
}

/**
 * Changes a counterparty's configured payment limit, and with it the current one screening derives. Applied after trying
 * it on past decisions, the form carries the limit tried and the window, and the change is refused once the limit is no
 * longer that one (policy replay P10).
 */
export async function updateCounterpartyLimitAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    try {
      const applied = await limitApplied(formData);
      const result = await changeCounterpartyLimit({
        actorId: auth.user.id,
        counterpartyId: id.data,
        raw: formString(formData, "paymentLimit"),
        ...(applied ? { expected: applied.expected, replay: applied.replay } : {}),
      });
      revalidateOrgPages();
      // A higher limit can unblock a payment held over the old one, so the agent looks again within a minute
      // (follow-up reopens it). A lower one, or one screening allows none of, unblocks nothing.
      if (result.from !== null && result.to !== null && result.to > result.from && (result.current ?? 0) > 0) {
        raiseCycleEvent(auth, "limit_raised");
      }
      if (result.to === null) return { ok: true, message: `${result.name}'s payment limit cleared.` };
      return {
        ok: true,
        message:
          result.current === result.to
            ? `${result.name}'s payment limit is now ${result.to} USDC.`
            : `${result.name}'s payment limit is now ${result.to} USDC; screening allows ${result.current} USDC for its risk.`,
      };
    } catch (error) {
      return addressFailure(error, "counterparty limit change failed");
    }
  });
}

/**
 * Marks a counterparty as paid without purchase orders, or as needing them again (three-way match design M2): whether
 * the agent needs a purchase order on file before it pays or schedules the counterparty's invoices.
 */
export async function updateCounterpartyPurchaseOrdersAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    const required = formString(formData, "purchaseOrderRequired");
    if (required !== "true" && required !== "false") return { ok: false, message: "Choose whether this counterparty needs purchase orders." };
    try {
      const result = await changeCounterpartyPurchaseOrders({ actorId: auth.user.id, counterpartyId: id.data, required: required === "true" });
      revalidateOrgPages();
      if (result.to) return { ok: true, message: `${result.name} needs a purchase order on file again before the agent pays it.` };
      // Relaxing it can complete a match that waited for a purchase order, so the agent looks again within a minute
      // (follow-up reopens it, M5). Requiring them again unblocks nothing.
      raiseCycleEvent(auth, "purchase_orders_waived");
      return { ok: true, message: `The agent now pays ${result.name} without a purchase order. It still needs the goods or services marked received.` };
    } catch (error) {
      return addressFailure(error, "counterparty purchase order change failed");
    }
  });
}

/** Sets, changes or clears a counterparty's billing email: a payee's payment notices, a client's reminders (collections R8). */
export async function updateCounterpartyNoticeEmailAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    const email = noticeEmailSchema.safeParse(formString(formData, "noticeEmail"));
    if (!email.success) return { ok: false, message: email.error.issues[0]?.message ?? "That email address does not look right" };
    try {
      const result = await changeCounterpartyNoticeEmail({ actorId: auth.user.id, counterpartyId: id.data, email: email.data });
      revalidateOrgPages();
      return {
        ok: true,
        message:
          result.role === "client"
            ? result.email
              ? `Reminders to ${result.name} go to ${result.email} once you turn them on for an invoice.`
              : `${result.name} has no billing email: the agent sends it no reminders.`
            : result.email
              ? `${result.name} is emailed at ${result.email} when it is paid.`
              : `${result.name} is no longer emailed when it is paid.`,
      };
    } catch (error) {
      console.error("notice email change failed", error instanceof Error ? error.message : error);
      return { ok: false, message: error instanceof Error && error.message === "Counterparty not found." ? error.message : "That did not work. Try again in a moment." };
    }
  });
}

/**
 * Confirms a changed address, as the page showed it, so payments to it are decided as usual again. The page shows the
 * chain beside the address (payee invoice link P3), and sends it as `chain`: a chain that is no longer the payee's is
 * refused as stale, like an address. The form's record of how the address was checked (payee lock PL2) is read here,
 * required when the workspace's payee lock is on, and signed with the confirmation.
 */
export async function confirmCounterpartyAddressAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "workspace.read");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    // Whoever decides payments confirms an address, and an accountant does while co-signing is on (accountant co-sign CS6).
    const role = auth.membership.role;
    if (!can(role, "approval.decide") && !(await cosignsNow(role))) return { ok: false, message: `Your role in this workspace (${role}) cannot do that.` };
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    const shownChain = formString(formData, "chain");
    try {
      const lock = await readPayeeLock(db());
      const record = parseVerification(
        {
          method: formString(formData, "method"),
          contact: formString(formData, "contact"),
          contactOnFileBefore: formString(formData, "contactOnFileBefore"),
          note: formString(formData, "note"),
        },
        lock.on
      );
      if (!record.ok) return { ok: false, message: record.message };
      const confirmed = await confirmCounterpartyAddress({
        actorId: auth.user.id,
        counterpartyId: id.data,
        shownAddress: formString(formData, "address"),
        ...(shownChain ? { shownChain } : {}),
        via: "confirm",
        verification: record.verification,
      });
      revalidateOrgPages();
      if (confirmed) raiseCycleEvent(auth, "address_confirmed");
      if (!confirmed) return { ok: true, message: "This address is already confirmed." };
      // Inside the payee lock's wait (PL5), payments still wait: the confirmation says until when, not that they go now.
      const until = lock.on && lock.coolingHours > 0 ? await coolingOffUntilFor(id.data, lock) : null;
      return {
        ok: true,
        message: until
          ? `Address confirmed. The payee lock keeps payments to it waiting until ${coolingOffLabel(until)}.`
          : "Address confirmed. Payments to it are decided as usual again.",
      };
    } catch (error) {
      return addressFailure(error, "counterparty address confirmation failed");
    }
  });
}

/**
 * Unfreezes a payee whose contact on file said they did not make an address change (address change check AC4), for an
 * owner or admin, with a note of how they settled it. Its address still needs confirming before anything is paid.
 */
export async function unfreezeCounterpartyAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    try {
      await unfreezeCounterparty({
        orgId: auth.membership.orgId,
        actorId: auth.user.id,
        role: auth.membership.role,
        counterpartyId: id.data,
        note: formString(formData, "note"),
      });
      revalidateOrgPages();
      return { ok: true, message: "Unfrozen. Its address still needs confirming before it is paid." };
    } catch (error) {
      if (error instanceof UnfreezeError) return { ok: false, message: error.message };
      console.error("unfreeze failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function createInvoiceAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    // A bill in the business's own currency, in shadow mode, is taken at its USDC amount at the day's rate, with the
    // bill's own figure kept beside it (shadow mode S6). Anywhere else, and for USDC or EURC, the form is read as typed.
    let amount = formString(formData, "amount");
    let currency = formString(formData, "currency");
    let original: OriginalBill | undefined;
    if (currency.trim() !== "" && !(INVOICE_CURRENCIES as readonly string[]).includes(currency.trim().toUpperCase())) {
      try {
        const bill = await shadowBill({ currency, amount });
        ({ original } = bill);
        amount = String(bill.usdc);
        currency = "USDC";
      } catch (error) {
        if (error instanceof ShadowBillError || error instanceof FxRateError) return { ok: false, message: error.message };
        throw error;
      }
    }
    const parsed = invoiceInputSchema.safeParse({
      direction: formString(formData, "direction"),
      counterpartyId: formString(formData, "counterpartyId"),
      amount,
      currency,
      memo: formString(formData, "memo"),
      poReference: formString(formData, "poReference"),
      invoiceNumber: formString(formData, "invoiceNumber"),
      goodsReceived: formData.get("goodsReceived") === "on",
      dueDate: formString(formData, "dueDate"),
      earlyPayDiscountPct: formString(formData, "earlyPayDiscountPct"),
      discountDeadline: formString(formData, "discountDeadline"),
    });
    if (!parsed.success) return { ok: false, ...invoiceFormRefusal(parsed.error) };

    const input = parsed.data;
    try {
      // An invoice read from a document records where it came from (invoice from a document D8).
      const document = documentProvenance(formData, {
        amount: input.amount,
        currency: input.currency,
        dueDate: input.dueDate,
        poReference: input.poReference,
        earlyPayDiscountPct: input.earlyPayDiscountPct,
        discountDeadline: input.discountDeadline,
        memo: input.memo,
        counterpartyId: input.counterpartyId,
      });
      // The counterparty is looked up in the organization's scope, so another organization's id is not found
      // rather than linked to this organization's invoice, and is answered exactly like one that does not exist.
      const created = await createInvoice({ actorId: auth.user.id, invoice: input, document, ...(original ? { original } : {}) });
      if (!created) return { ok: false, message: "Counterparty not found." };
      // The project it belongs to, chosen on the form (project budgets P3): its money is set aside as it is added.
      const projectId = formString(formData, "projectId").trim();
      const placed = UUID_PATTERN.test(projectId)
        ? await assignToProjectCommand(consoleActor(auth), { subject: { kind: "bill", id: created.id }, projectId, atEntry: true })
        : null;
      const inProject = placed === null ? "" : placed.ok ? ` ${placed.message}` : ` It was not put in the project: ${placed.message}`;

      revalidatePath("/");
      revalidateOrgPages();
      if (input.direction !== "payable") return { ok: true, created: 1, message: `Invoice added for ${created.counterpartyName}.${inProject}` };
      raiseCycleEvent(auth, "invoice_added");
      return { ok: true, created: 1, message: `Invoice added for ${created.counterpartyName}. The agent usually decides on it within a minute.${inProject}` };
    } catch (error) {
      console.error("invoice intake failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "Invoice could not be added." };
    }
  });
}

/** When the payee lock's wait on this counterparty's changed address ends, while it is still ahead (PL5); best effort. */
async function coolingOffUntilFor(counterpartyId: string, lock: Awaited<ReturnType<typeof readPayeeLock>>): Promise<Date | null> {
  try {
    const found = await db().from("counterparties").select("address_changed_at").eq("id", counterpartyId).maybeSingle();
    if (found.error) return null;
    return inCoolingOff((found.data as { address_changed_at: string | null } | null)?.address_changed_at ?? null, lock);
  } catch {
    return null;
  }
}
