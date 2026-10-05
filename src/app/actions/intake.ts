"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { db, unwrap } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import {
  counterpartyInputSchema,
  csvBatchMessage,
  csvInvoiceInputSchema,
  dueDateIso,
  firstZodMessage,
  invoiceFormRefusal,
  invoiceInputSchema,
  noticeEmailSchema,
  type InvoiceField,
} from "@/lib/intake-validation";
import { changeCounterpartyNoticeEmail } from "@/lib/payment-notices";
import {
  changeCounterpartyAddress,
  confirmCounterpartyAddress,
  CounterpartyAddressError,
} from "@/lib/counterparty-address";
import { changeCounterpartyLimit, CounterpartyLimitError } from "@/lib/counterparty-limit";
import { changeCounterpartyPurchaseOrders, CounterpartyPurchaseOrdersError } from "@/lib/counterparty-purchase-orders";
import { documentProvenance } from "@/lib/invoice-document/provenance";
import { createCounterparty } from "@/lib/counterparties/create";
import { createInvoice } from "@/lib/invoices/create";
import { appendLedgerEntry } from "@/lib/ledger";

export interface IntakeActionResult {
  ok: boolean;
  message: string;
  created?: number;
  verdict?: string;
  /** The invoice form's refused fields, each with its first error, shown under the field. */
  fieldErrors?: Partial<Record<InvoiceField, string>>;
}

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

    try {
      // The one way a counterparty is added, shared with the write API (write API R2).
      const counterparty = await createCounterparty({ actorId: auth.user.id, counterparty: parsed.data });
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
  if (error instanceof CounterpartyAddressError || error instanceof CounterpartyLimitError || error instanceof CounterpartyPurchaseOrdersError) {
    return { ok: false, message: error.message };
  }
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: "That did not work. Try again in a moment." };
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
      const result = await changeCounterpartyAddress({ actorId: auth.user.id, counterpartyId: id.data, raw: formString(formData, "address") });
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

/** Changes a counterparty's configured payment limit, and with it the current one screening derives. */
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
      const result = await changeCounterpartyLimit({ actorId: auth.user.id, counterpartyId: id.data, raw: formString(formData, "paymentLimit") });
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

/** Confirms a changed address, as the page showed it, so payments to it are decided as usual again. */
export async function confirmCounterpartyAddressAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyIdSchema.safeParse(formString(formData, "counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    try {
      const confirmed = await confirmCounterpartyAddress({
        actorId: auth.user.id,
        counterpartyId: id.data,
        shownAddress: formString(formData, "address"),
        via: "confirm",
      });
      revalidateOrgPages();
      if (confirmed) raiseCycleEvent(auth, "address_confirmed");
      return { ok: true, message: confirmed ? "Address confirmed. Payments to it are decided as usual again." : "This address is already confirmed." };
    } catch (error) {
      return addressFailure(error, "counterparty address confirmation failed");
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
    const parsed = invoiceInputSchema.safeParse({
      direction: formString(formData, "direction"),
      counterpartyId: formString(formData, "counterpartyId"),
      amount: formString(formData, "amount"),
      currency: formString(formData, "currency"),
      memo: formString(formData, "memo"),
      poReference: formString(formData, "poReference"),
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
      const created = await createInvoice({ actorId: auth.user.id, invoice: input, document });
      if (!created) return { ok: false, message: "Counterparty not found." };

      revalidatePath("/");
      revalidateOrgPages();
      if (input.direction !== "payable") return { ok: true, created: 1, message: `Invoice added for ${created.counterpartyName}.` };
      raiseCycleEvent(auth, "invoice_added");
      return { ok: true, created: 1, message: `Invoice added for ${created.counterpartyName}. The agent usually decides on it within a minute.` };
    } catch (error) {
      console.error("invoice intake failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "Invoice could not be added." };
    }
  });
}

const csvBatchSchema = z.array(csvInvoiceInputSchema).min(1, "CSV contains no invoices").max(200, "Import at most 200 invoices at a time");

export async function importInvoicesAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const rowsJson = formString(formData, "rowsJson");
    let decoded: unknown;
    try {
      decoded = JSON.parse(rowsJson);
    } catch {
      return { ok: false, message: "CSV preview is invalid. Choose the file again." };
    }
    const parsed = csvBatchSchema.safeParse(decoded);
    if (!parsed.success) return { ok: false, message: csvBatchMessage(parsed.error) };

    try {
      const counterparties = unwrap(
        await db().from("counterparties").select("id, name")
      ) as Array<{ id: string; name: string }>;
      const byName = new Map<string, Array<{ id: string; name: string }>>();
      for (const counterparty of counterparties) {
        const key = counterparty.name.trim().toLocaleLowerCase("en-US");
        byName.set(key, [...(byName.get(key) ?? []), counterparty]);
      }

      const resolved = parsed.data.map((row, index) => {
        const matches = byName.get(row.counterparty.toLocaleLowerCase("en-US")) ?? [];
        if (matches.length === 0) throw new Error(`Row ${index + 1}: counterparty “${row.counterparty}” was not found.`);
        if (matches.length > 1) throw new Error(`Row ${index + 1}: counterparty “${row.counterparty}” is ambiguous.`);
        return { row, counterparty: matches[0] };
      });

      const inserted = unwrap(
        await db()
          .from("invoices")
          .insert(resolved.map(({ row, counterparty }) => ({
            direction: row.direction,
            counterparty_id: counterparty.id,
            amount: row.amount,
            currency: row.currency,
            memo: row.memo,
            po_reference: row.po_reference,
            goods_received: row.goods_received,
            due_date: dueDateIso(row.due_date),
            early_pay_discount_pct: row.early_pay_discount_pct,
            discount_due_date: row.discount_deadline ? dueDateIso(row.discount_deadline) : null,
            created_by: auth.user.id,
          })))
          .select("id")
      ) as Array<{ id: string }>;

      for (let index = 0; index < inserted.length; index += 1) {
        const { row, counterparty } = resolved[index];
        await appendLedgerEntry({
          actor: "human",
          domain: row.direction === "payable" ? "ap" : "ar",
          action: "import_invoice",
          summary: `Imported ${row.direction} invoice for ${counterparty.name}: ${row.amount} ${row.currency}`,
          detail: {
            by: auth.user.id,
            invoiceId: inserted[index].id,
            importMethod: "csv_preview_confirm",
            counterpartyId: counterparty.id,
            counterpartyName: counterparty.name,
            amount: row.amount,
            currency: row.currency,
            dueDate: row.due_date,
            poReference: row.po_reference,
            goodsReceived: row.goods_received,
          },
        });
      }

      revalidatePath("/");
      revalidateOrgPages();
      if (resolved.some(({ row }) => row.direction === "payable")) raiseCycleEvent(auth, "invoice_added");
      return { ok: true, created: inserted.length, message: `Imported ${inserted.length} invoice${inserted.length === 1 ? "" : "s"}.` };
    } catch (error) {
      console.error("invoice CSV import failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "Invoices could not be imported." };
    }
  });
}
