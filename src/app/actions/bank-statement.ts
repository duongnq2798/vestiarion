"use server";

import "server-only";

import { z } from "zod";
import { consoleAnswer } from "@/app/actions/command-result";
import { ActualPaymentError } from "@/lib/actual-payments";
import { ROLES } from "@/lib/bank-statement/columns";
import { STATEMENT_MAX_BYTES, type StatementLine } from "@/lib/bank-statement/lines";
import type { LineMatch } from "@/lib/bank-statement/match";
import { StatementReadError } from "@/lib/bank-statement/table";
import { previewStatement, StatementImportError } from "@/lib/bank-statements";
import { authorize } from "@/lib/auth/authorize";
import { consoleActor } from "@/lib/commands/actor";
import { importBankStatement, STATEMENT_MAX_PAIRS, type NotSavedLine } from "@/lib/commands/statements";
import { inOrg } from "@/lib/dal/scope";

/**
 * What the business paid, from its bank statement, on the report's comparison (docs/superpowers/specs/2026-10-10-bank-
 * statement-design.md B1, B8, B12): the statement matched against the payables, then the lines the person ticked saved.
 * What crosses is the text and the person's choices, never the browser's lines: the server reads them again. By someone
 * who may enter records (`records.write`), through the command, inside the workspace's scope.
 */

const column = z.number().int().min(0).max(1000).nullable();
const choicesSchema = z.object({
  delimiter: z.enum([",", ";", "\t", "|"]).nullable().optional(),
  headerRow: z.number().int().min(-1).max(100_000).nullable().optional(),
  columns: z.object(Object.fromEntries(ROLES.map((role) => [role, column])) as Record<(typeof ROLES)[number], typeof column>).nullable().optional(),
  outIs: z.enum(["negative", "positive"]).optional(),
  dateOrder: z.enum(["ymd", "dmy", "mdy"]).nullable().optional(),
  decimalMark: z.enum([".", ","]).nullable().optional(),
  currency: z.string().max(10).nullable().optional(),
});
const statementSchema = z.object({
  account: z.string().max(200),
  text: z.string().min(1).max(STATEMENT_MAX_BYTES),
  choices: choicesSchema,
});
const importSchema = statementSchema.extend({
  pairs: z.array(z.object({ line: z.number().int().min(1), invoiceId: z.string().uuid() })).max(STATEMENT_MAX_PAIRS * 10),
});
const NOT_READ = "That statement could not be read. Choose a CSV smaller than 2 MB.";

export async function previewStatementAction(
  orgSlug: string,
  input: unknown
): Promise<{ ok: boolean; message: string; lines?: StatementLine[]; matches?: LineMatch[] }> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  const parsed = statementSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_READ };
  return inOrg(auth, async () => {
    try {
      const { read, matches } = await previewStatement({ ...parsed.data, today: new Date().toISOString().slice(0, 10) });
      if (!matches) return { ok: false, message: read.problems[0] ?? "Answer the questions about the statement first." };
      return { ok: true, message: "", lines: read.lines, matches };
    } catch (error) {
      if (error instanceof StatementReadError || error instanceof StatementImportError || error instanceof ActualPaymentError) return { ok: false, message: error.message };
      console.error("bank statement preview failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}

export async function importStatementAction(orgSlug: string, input: unknown): Promise<{ ok: boolean; message: string; notSaved: NotSavedLine[] }> {
  const auth = await authorize(orgSlug, "records.write");
  if (!auth.ok) return { ok: false, message: auth.message, notSaved: [] };
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: NOT_READ, notSaved: [] };
  return inOrg(auth, async () => {
    const outcome = await importBankStatement(consoleActor(auth), parsed.data);
    return { ...consoleAnswer(outcome), notSaved: outcome.ok ? outcome.notSaved : [] };
  });
}
