"use server";

import "server-only";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { hasAgentControlSession } from "@/lib/agent-session";
import { screenCounterparty } from "@/lib/compliance";
import {
  counterpartyInputSchema,
  csvInvoiceInputSchema,
  dueDateIso,
  firstZodMessage,
  invoiceInputSchema,
} from "@/lib/intake-validation";
import { appendLedgerEntry } from "@/lib/ledger";
import { supabase, unwrap } from "@/lib/supabase";

export interface IntakeActionResult {
  ok: boolean;
  message: string;
  created?: number;
  verdict?: string;
}

const INITIAL_FAILURE: IntakeActionResult = { ok: false, message: "Control session expired. Unlock controls and try again." };

async function authorized(): Promise<boolean> {
  return hasAgentControlSession();
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function createCounterpartyAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  if (!(await authorized())) return INITIAL_FAILURE;

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
      await supabase()
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
      revalidatePath("/counterparties");
      revalidatePath("/compliance");
      revalidatePath("/audit");
      return {
        ok: true,
        created: 1,
        verdict: screening.riskLevel,
        message: `${counterparty.name} added and screened: ${screening.riskLevel} risk.`,
      };
    } catch (error) {
      revalidatePath("/counterparties");
      revalidatePath("/compliance");
      revalidatePath("/audit");
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
}

export async function createInvoiceAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  if (!(await authorized())) return INITIAL_FAILURE;

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
    const counterparty = unwrap(
      await supabase()
        .from("counterparties")
        .select("id, name")
        .eq("id", input.counterpartyId)
        .single<{ id: string; name: string }>()
    );
    const invoice = unwrap(
      await supabase()
        .from("invoices")
        .insert({
          direction: input.direction,
          counterparty_id: counterparty.id,
          amount: input.amount,
          memo: input.memo,
          po_reference: input.poReference,
          goods_received: input.goodsReceived,
          due_date: dueDateIso(input.dueDate),
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
        invoiceId: invoice.id,
        counterpartyId: counterparty.id,
        counterpartyName: counterparty.name,
        amount: input.amount,
        dueDate: input.dueDate,
        poReference: input.poReference,
        goodsReceived: input.goodsReceived,
      },
    });

    revalidatePath("/invoices");
    revalidatePath("/");
    revalidatePath("/audit");
    return { ok: true, created: 1, message: `Invoice added for ${counterparty.name}.` };
  } catch (error) {
    console.error("invoice intake failed", error);
    return { ok: false, message: error instanceof Error ? error.message : "Invoice could not be added." };
  }
}

const csvBatchSchema = z.array(csvInvoiceInputSchema).min(1, "CSV contains no invoices").max(200, "Import at most 200 invoices at a time");

export async function importInvoicesAction(
  _previous: IntakeActionResult,
  formData: FormData
): Promise<IntakeActionResult> {
  if (!(await authorized())) return INITIAL_FAILURE;

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
      await supabase().from("counterparties").select("id, name")
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
      await supabase()
        .from("invoices")
        .insert(resolved.map(({ row, counterparty }) => ({
          direction: row.direction,
          counterparty_id: counterparty.id,
          amount: row.amount,
          memo: row.memo,
          po_reference: row.po_reference,
          goods_received: row.goods_received,
          due_date: dueDateIso(row.due_date),
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

    revalidatePath("/invoices");
    revalidatePath("/");
    revalidatePath("/audit");
    return { ok: true, created: inserted.length, message: `Imported ${inserted.length} invoice${inserted.length === 1 ? "" : "s"}.` };
  } catch (error) {
    console.error("invoice CSV import failed", error);
    return { ok: false, message: error instanceof Error ? error.message : "Invoices could not be imported." };
  }
}
