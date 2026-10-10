"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { ActualPaymentError, previewActualsCsv } from "@/lib/actual-payments";
import { ACTUALS_CSV_MAX_BYTES, ActualsCsvError, type PreviewRow } from "@/lib/actual-payments-csv";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { importActualPayments, recordActualPayment } from "@/lib/commands/actuals";
import { inOrg } from "@/lib/dal/scope";

/**
 * What the business paid outside Vestiarion, from the report's comparison (docs/superpowers/specs/2026-10-10-actual-
 * payments-design.md A4–A6): one bill, or a CSV previewed first. By someone who may enter records (`records.write`), as
 * adding an invoice is, through the commands, inside the workspace's scope.
 */

const text = (max: number) => z.string().max(max).optional();

const recordSchema = z.discriminatedUnion("outcome", [
  z.object({
    invoiceId: z.string().uuid(),
    outcome: z.literal("paid"),
    paidOn: z.string().max(20),
    amount: z.string().max(40),
    currency: z.string().max(10),
    method: z.string().max(20),
    reference: text(1000),
    note: text(2000),
    replaces: z.string().uuid().nullable().optional(),
  }),
  z.object({
    invoiceId: z.string().uuid(),
    outcome: z.literal("not_paid"),
    reason: z.string().max(2000),
    note: text(2000),
    replaces: z.string().uuid().nullable().optional(),
  }),
]);

const csvSchema = z.string().min(1).max(ACTUALS_CSV_MAX_BYTES);
const TOO_BIG = "Choose a CSV smaller than 1 MB.";

export async function recordActualPaymentAction(orgSlug: string, input: unknown): Promise<{ ok: boolean; message: string }> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = recordSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "That record could not be read." };
  return inOrg(auth, async () => consoleAnswer(await recordActualPayment(consoleActor(auth), parsed.data)));
}

export async function previewActualsCsvAction(orgSlug: string, csv: unknown): Promise<{ ok: boolean; message: string; rows?: PreviewRow[] }> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = csvSchema.safeParse(csv);
  if (!parsed.success) return { ok: false, message: TOO_BIG };
  return inOrg(auth, async () => {
    try {
      const rows = await previewActualsCsv(parsed.data, new Date().toISOString().slice(0, 10));
      return { ok: true, message: "", rows };
    } catch (error) {
      if (error instanceof ActualPaymentError || error instanceof ActualsCsvError) return { ok: false, message: error.message };
      console.error("payments CSV preview failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function importActualsCsvAction(orgSlug: string, csv: unknown): Promise<{ ok: boolean; message: string }> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = csvSchema.safeParse(csv);
  if (!parsed.success) return { ok: false, message: TOO_BIG };
  return inOrg(auth, async () => consoleAnswer(await importActualPayments(consoleActor(auth), { csv: parsed.data })));
}
