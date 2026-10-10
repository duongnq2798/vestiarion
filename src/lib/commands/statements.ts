import { ActualPaymentError } from "../actual-payments";
import type { StatementChoices } from "../bank-statement/lines";
import { StatementReadError } from "../bank-statement/table";
import { matchStatementNow, recordStatementLine, StatementImportError, type StatementMatched } from "../bank-statements";
import { plural } from "../copy";
import type { Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Filling in what the business paid from its bank statement (docs/superpowers/specs/2026-10-10-bank-statement-design.md
 * B8): the lines the person ticked, each with the bill it paid. A record of what was paid, so `records.write`, from the
 * console only, as the CSV import. The statement is read and matched again here, and a pair is saved only while its
 * bill is still one of its line's candidates and no line or bill is ticked twice.
 */

export const STATEMENT_MAX_PAIRS = 200;

export interface StatementPair {
  /** The line of the file. */
  line: number;
  invoiceId: string;
}

export interface NotSavedLine {
  line: number;
  why: string;
}

export async function importBankStatement(
  actor: Actor,
  input: { account: string; text: string; choices: StatementChoices; pairs: StatementPair[]; today?: string }
): Promise<CommandOutcome<{ saved: number; corrected: number; notSaved: NotSavedLine[] }>> {
  const refusal = gate(actor, "payable.import_statement");
  if (refusal) return refusal;
  if (input.pairs.length === 0) return refused("nothing_ticked", "Tick at least one line to save.");
  if (input.pairs.length > STATEMENT_MAX_PAIRS) return refused("too_many", `Save at most ${STATEMENT_MAX_PAIRS} payments at a time.`);
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  let matched: StatementMatched;
  try {
    // Read and matched again here, against the payables as they are now: what is saved is what a fresh preview says.
    matched = await matchStatementNow({ account: input.account, text: input.text, choices: input.choices, today });
  } catch (error) {
    if (error instanceof StatementReadError) return refused("statement", error.message);
    if (error instanceof StatementImportError || error instanceof ActualPaymentError) return refused(error.code, error.message);
    console.error("reading a bank statement failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", TRY_AGAIN);
  }
  const { read, matches } = matched;
  if (!matches) return refused("statement", read.problems[0] ?? "Answer the questions about the statement first.");

  const lineCount = new Map<number, number>();
  const billCount = new Map<string, number>();
  for (const pair of input.pairs) {
    lineCount.set(pair.line, (lineCount.get(pair.line) ?? 0) + 1);
    billCount.set(pair.invoiceId, (billCount.get(pair.invoiceId) ?? 0) + 1);
  }

  let saved = 0;
  let corrected = 0;
  const notSaved: NotSavedLine[] = [];
  for (const pair of input.pairs) {
    const notThis = (why: string) => notSaved.push({ line: pair.line, why });
    if (lineCount.get(pair.line)! > 1) {
      notThis("This line is ticked twice.");
      continue;
    }
    if (billCount.get(pair.invoiceId)! > 1) {
      notThis("Another ticked line is matched to the same bill.");
      continue;
    }
    const index = read.lines.findIndex((line) => line.line === pair.line);
    if (index === -1) {
      notThis("That line is not in the statement as read. Read the statement again.");
      continue;
    }
    const match = matches[index];
    let replaces: string | null | undefined;
    if (match.status === "matched" && match.candidate.invoiceId === pair.invoiceId) replaces = match.candidate.replaces;
    else if (match.status === "choose") replaces = match.candidates.find((candidate) => candidate.invoiceId === pair.invoiceId)?.replaces;
    if (replaces === undefined) {
      notThis(
        match.status === "used"
          ? `This line recorded a payment already, for ${match.payee}.`
          : match.status === "recorded"
            ? `The record of ${match.payee} says this line already.`
            : match.status === "money_in"
              ? "Money in is not matched to bills."
              : "That bill is not one this line could have paid. Read the statement again."
      );
      continue;
    }
    try {
      // The line kept, then its record and signed entry, a correction of the bill's newest record when it has one.
      const result = await recordStatementLine({ actorId: actor.userId, account: input.account, line: read.lines[index], invoiceId: pair.invoiceId, replaces, today });
      saved += 1;
      if (result.corrected) corrected += 1;
    } catch (error) {
      const known = error instanceof ActualPaymentError || error instanceof StatementImportError;
      if (!known) console.error("saving a bank statement line failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
      notThis(known ? error.message : TRY_AGAIN);
    }
  }

  const notSavedWords = notSaved.length > 0 ? ` ${notSaved.length} ${plural(notSaved.length, "line was", "lines were")} not saved.` : "";
  // Nothing saved: the first line's reason goes with the refusal, which carries no list.
  if (saved === 0) return refused("nothing_saved", `No payment was saved.${notSavedWords}${notSaved[0] ? ` Line ${notSaved[0].line}: ${notSaved[0].why}` : ""}`);
  const fresh = saved - corrected;
  const split = [fresh > 0 ? `${fresh} new` : "", corrected > 0 ? `${corrected} ${plural(corrected, "correction", "corrections")}` : ""].filter(Boolean).join(", ");
  return done(`Saved ${saved} ${plural(saved, "payment", "payments")} from the statement: ${split}.${notSavedWords}`, { saved, corrected, notSaved });
}
