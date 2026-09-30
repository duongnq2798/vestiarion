"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { screenCounterparty } from "@/lib/compliance";
import { db, unwrap } from "@/lib/dal";
import { inOrg } from "@/lib/dal/scope";
import {
  counterpartyInputSchema,
  csvInvoiceInputSchema,
  dueDateIso,
  firstZodMessage,
  invoiceInputSchema,
} from "@/lib/intake-validation";
import {
  changeCounterpartyAddress,
  confirmCounterpartyAddress,
  CounterpartyAddressError,
} from "@/lib/counterparty-address";
import { appendLedgerEntry } from "@/lib/ledger";

export interface IntakeActionResult {
  ok: boolean;
  message: string;
  created?: number;
  verdict?: string;
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
      role: formString(formData, "role"),
      address: formString(formData, "address"),
      chain: formString(formData, "chain"),
      jurisdiction: formString(formData, "jurisdiction"),
      paymentLimit: formString(formData, "paymentLimit"),
    });
    if (!parsed.success) return { ok: false, message: firstZodMessage(parsed.error) };

    const input = parsed.data;
    try {
      const counterparty = unwrap(
        await db()
          .from("counterparties")
          .insert({
            name: input.name,
            role: input.role,
            address: input.address,
            chain: input.chain,
            jurisdiction: input.jurisdiction,
            baseline_payment_limit: input.paymentLimit || null,
            payment_limit: null,
          })
          .select("id, name")
          .single<{ id: string; name: string }>()
      );

      await appendLedgerEntry({
        actor: "human",
        domain: "compliance",
        action: "create_counterparty",
        summary: `Added ${counterparty.name} as a ${input.role}`,
        detail: {
          by: auth.user.id,
          counterpartyId: counterparty.id,
          role: input.role,
          chain: input.chain,
          address: input.address,
          jurisdiction: input.jurisdiction,
          baselinePaymentLimit: input.paymentLimit || null,
        },
      });

      try {
        const screening = await screenCounterparty(counterparty.id);
        revalidateOrgPages();
        return {
          ok: true,
          created: 1,
          verdict: screening.riskLevel,
          message: `${counterparty.name} added and screened: ${screening.riskLevel} risk.`,
        };
      } catch (error) {
        revalidateOrgPages();
        return {
          ok: true,
          created: 1,
          verdict: "incomplete",
          message: `${counterparty.name} was added, but screening is incomplete: ${error instanceof Error ? error.message : "provider unavailable"}`,
        };
      }
    } catch (error) {
      console.error("counterparty intake failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "Counterparty could not be added." };
    }
  });
}

const counterpartyIdSchema = z.string().uuid();

/** A `CounterpartyAddressError` carries a message safe to show; anything else stays in the server log. */
function addressFailure(error: unknown, what: string): IntakeActionResult {
  if (error instanceof CounterpartyAddressError) return { ok: false, message: error.message };
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
      memo: formString(formData, "memo"),
      poReference: formString(formData, "poReference"),
      goodsReceived: formData.get("goodsReceived") === "on",
      dueDate: formString(formData, "dueDate"),
    });
    if (!parsed.success) return { ok: false, message: firstZodMessage(parsed.error) };

    const input = parsed.data;
    try {
      // Scoped to the organization, so another organization's counterparty id
      // is not found here rather than linked to this organization's invoice,
      // and is answered exactly like one that does not exist.
      const lookup = await db()
        .from("counterparties")
        .select("id, name")
        .eq("id", input.counterpartyId)
        .maybeSingle<{ id: string; name: string }>();
      if (lookup.error) throw new Error(lookup.error.message);
      const counterparty = lookup.data;
      if (!counterparty) return { ok: false, message: "Counterparty not found." };
      const invoice = unwrap(
        await db()
          .from("invoices")
          .insert({
            direction: input.direction,
            counterparty_id: counterparty.id,
            amount: input.amount,
            memo: input.memo,
            po_reference: input.poReference,
            goods_received: input.goodsReceived,
            due_date: dueDateIso(input.dueDate),
            created_by: auth.user.id,
          })
          .select("id")
          .single<{ id: string }>()
      );

      await appendLedgerEntry({
        actor: "human",
        domain: input.direction === "payable" ? "ap" : "ar",
        action: "create_invoice",
        summary: `Added ${input.direction} invoice for ${counterparty.name}: ${input.amount} USDC`,
        detail: {
          by: auth.user.id,
          invoiceId: invoice.id,
          counterpartyId: counterparty.id,
          counterpartyName: counterparty.name,
          amount: input.amount,
          dueDate: input.dueDate,
          poReference: input.poReference,
          goodsReceived: input.goodsReceived,
        },
      });

      revalidatePath("/");
      revalidateOrgPages();
      return { ok: true, created: 1, message: `Invoice added for ${counterparty.name}.` };
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
    if (!parsed.success) return { ok: false, message: firstZodMessage(parsed.error) };

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
            memo: row.memo,
            po_reference: row.po_reference,
            goods_received: row.goods_received,
            due_date: dueDateIso(row.due_date),
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
          summary: `Imported ${row.direction} invoice for ${counterparty.name}: ${row.amount} USDC`,
          detail: {
            by: auth.user.id,
            invoiceId: inserted[index].id,
            importMethod: "csv_preview_confirm",
            counterpartyId: counterparty.id,
            counterpartyName: counterparty.name,
            amount: row.amount,
            dueDate: row.due_date,
            poReference: row.po_reference,
            goodsReceived: row.goods_received,
          },
        });
      }

      revalidatePath("/");
      revalidateOrgPages();
      return { ok: true, created: inserted.length, message: `Imported ${inserted.length} invoice${inserted.length === 1 ? "" : "s"}.` };
    } catch (error) {
      console.error("invoice CSV import failed", error);
      return { ok: false, message: error instanceof Error ? error.message : "Invoices could not be imported." };
    }
  });
}
