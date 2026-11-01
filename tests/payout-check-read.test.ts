import { describe, expect, it } from "vitest";
import {
  answeredDecimalMark,
  blankTokenIsNative,
  detectPayoutColumns,
  looksLikePayoutHeader,
  PAYOUT_FILE_MAX_BYTES,
  PAYOUT_ROWS_MAX,
  payoutDecimalMark,
  payoutQuestions,
  payoutRows,
  readPayoutAmount,
  readPayoutBatch,
  startingPayoutAnswers,
  unansweredPayout,
} from "@/lib/payout-check/read";

/**
 * The payout batch check's reader (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP2, CP6): a file or
 * pasted rows read as the bill import reads a list, a Disperse list among them, the columns found by their names (Safe's
 * CSV Airdrop with nothing to change) or by what the rows hold, the rows the check reads, the one question about how the
 * amounts are written, and each amount read to an exact decimal or what is wrong with it. Hidden characters are made
 * with String.fromCharCode, so none is hidden in this file.
 */

const A = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
const B = "0x562acedfa970dc60f109f21c66507b752413f4fb";
const C = "0x59bd40189e7f95b34975ecf4cf3da46ba8481133";
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const answersOf = (text: string) => {
  const table = readPayoutBatch(text);
  return { table, answers: startingPayoutAnswers(table) };
};

describe("reading a batch (payout check CP2)", () => {
  it("maps Safe's CSV Airdrop, and its older form of three columns, with nothing to change", () => {
    const safe = answersOf(`token_type,token_address,receiver,amount,id\nerc20,${USDC_ON_BASE},${A},10.5,\nnative,,${B},0.25,`);
    expect(safe.table.disperse).toBe(false);
    expect(safe.answers).toEqual({ hasHeader: true, columns: { tokenType: 0, token: 1, address: 2, amount: 3 }, decimalMark: null });
    const older = answersOf(`token_address,receiver,amount\n${USDC_ON_BASE},${A},10.5`);
    expect(older.answers.columns).toEqual({ token: 0, address: 1, amount: 2 });
    // A blank token_address is the chain's own coin in Safe's form, and in no other.
    expect(blankTokenIsNative(older.table, older.answers)).toBe(true);
    const sheet = answersOf(`Wallet,Amount,Token\n${A},10,`);
    expect(blankTokenIsNative(sheet.table, sheet.answers)).toBe(false);
  });

  it("reads a Disperse list, an address and an amount a line, separated by spaces, a comma or =, as two columns", () => {
    const text = `${A} 3.141592\n\n${B},2.7182\n${C}=1.41421\r\n  ${A}   10  \n${B} = 1,000.50`;
    const batch = readPayoutBatch(text);
    expect(batch.disperse).toBe(true);
    expect(batch.delimiter).toBe(",");
    expect(batch.rows).toEqual([
      { line: 1, cells: [A, "3.141592"] },
      { line: 3, cells: [B, "2.7182"] },
      { line: 4, cells: [C, "1.41421"] },
      { line: 5, cells: [A, "10"] },
      { line: 6, cells: [B, "1,000.50"] },
    ]);
    expect(startingPayoutAnswers(batch)).toEqual({ hasHeader: false, columns: { address: 0, amount: 1 }, decimalMark: null });
    // A byte-order mark before the first line is not part of its address.
    expect(readPayoutBatch(`${String.fromCharCode(0xfeff)}${A} 1`).rows[0].cells[0]).toBe(A);
  });

  it("reads a list as Disperse's only when every line has that form, so column names or a third column keep it a table", () => {
    expect(readPayoutBatch(`address,amount\n${A},1`)).toMatchObject({ disperse: false, rows: [{ cells: ["address", "amount"] }, { cells: [A, "1"] }] });
    expect(readPayoutBatch(`${A} 1\nNorthwind Design 2`).disperse).toBe(false);
    expect(readPayoutBatch(`${A},1,USDC`)).toMatchObject({ disperse: false, rows: [{ cells: [A, "1", "USDC"] }] });
    // A semicolon CSV is a table: its semicolons cut its columns, and its amounts keep their commas.
    expect(readPayoutBatch(`${A};1,5`)).toMatchObject({ disperse: false, delimiter: ";", rows: [{ cells: [A, "1,5"] }] });
    expect(readPayoutBatch(`"${A}",1`).disperse).toBe(false);
  });

  it("reads a line with a second comma as a CSV, never as an amount holding it: an id after the amount, or an empty column (payout check CP2)", () => {
    const ids = readPayoutBatch(`${A},100,8453\n${B},250,8453\n${C},75,8453`);
    expect(ids).toMatchObject({ disperse: false, rows: [{ cells: [A, "100", "8453"] }, { cells: [B, "250", "8453"] }, { cells: [C, "75", "8453"] }] });
    expect(startingPayoutAnswers(ids).columns).toEqual({ address: 0, amount: 1 });
    expect(readPayoutBatch(`${A},100,\n${B},1.5,`)).toMatchObject({ disperse: false, rows: [{ cells: [A, "100", ""] }, { cells: [B, "1.5", ""] }] });
    // After a space or =, the amount keeps its comma.
    expect(readPayoutBatch(`${A} 1,000.50\n${B}=2,5`)).toMatchObject({ disperse: true, rows: [{ cells: [A, "1,000.50"] }, { cells: [B, "2,5"] }] });
  });

  it("keeps a hidden character or a letter from another alphabet in a Disperse address, for the address checker to name", () => {
    const hidden = `${A.slice(0, 20)}${String.fromCharCode(0x200b)}${A.slice(20)}`;
    const cyrillic = `0${String.fromCharCode(0x0445)}${A.slice(2)}`;
    const spaced = `${A.slice(0, 20)}${String.fromCharCode(0xa0)}${A.slice(20)}`;
    expect(readPayoutBatch(`${hidden} 1\n${cyrillic} 2\n${spaced} 3`).rows.map((row) => row.cells[0])).toEqual([hidden, cyrillic, spaced]);
  });

  it("reads a semicolon CSV and rows pasted from a sheet, finding each column by the names businesses give it", () => {
    const semicolon = answersOf(`Payee;Wallet address;Amount\nNorthwind;${A};1.234,50`);
    expect(semicolon.table.delimiter).toBe(";");
    expect(semicolon.answers.columns).toEqual({ address: 1, name: 0, amount: 2 });
    const pasted = answersOf(`Recipient\tLabel\tValue\tCurrency\n${A}\tNorthwind\t10\tUSDC`);
    expect(pasted.table.delimiter).toBe("\t");
    expect(pasted.answers.columns).toEqual({ address: 0, name: 1, amount: 2, token: 3 });
    const table = readPayoutBatch("x");
    expect(detectPayoutColumns({ ...table, rows: [{ line: 1, cells: ["Contractor", "Pay-to address", "Qty", "Asset", "Token type"] }] }, true)).toEqual({
      name: 0,
      address: 1,
      amount: 2,
      token: 3,
      tokenType: 4,
    });
    expect(detectPayoutColumns({ ...table, rows: [{ line: 1, cells: ["To", "Recipient name", "Amount (USDC)", "Symbol"] }] }, true)).toEqual({
      address: 0,
      name: 1,
      amount: 2,
      token: 3,
    });
    expect(looksLikePayoutHeader(["Northwind Design", A, "10"])).toBe(false);
    expect(looksLikePayoutHeader(["Type", "Notes"])).toBe(false);
  });

  it("takes as the address the column named as one that holds the addresses, and a Recipient of names as the name (payout check CP2)", () => {
    expect(answersOf(`Recipient,Wallet,Amount\nAlice,${A},10\nBob,${B},20`).answers.columns).toEqual({ address: 1, name: 0, amount: 2 });
    expect(answersOf(`Receiver,Payout address,Payee\nNorthwind,base:${A},Northwind Design`).answers.columns).toEqual({ address: 1, name: 2 });
    // Two columns of addresses: the most telling name.
    expect(answersOf(`Wallet,Address,Amount\n${A},${B},1`).answers.columns).toEqual({ address: 1, amount: 2 });
  });

  it("finds the address and the amount by what the rows hold when the batch has no column names", () => {
    const { answers } = answersOf(`Northwind Design\t${A}\t$1,250.00\nHarbor Print\tbase:${B}\t300\nCedar\tnorthwind.eth\t12.5`);
    expect(answers).toEqual({ hasHeader: false, columns: { address: 1, amount: 2 }, decimalMark: null });
    expect(answersOf(`Northwind,${A}`).answers.columns).toEqual({ address: 1 });
  });

  it(`skips rows with no address and no amount, and reads at most ${PAYOUT_ROWS_MAX} rows, saying how many more were left out`, () => {
    const { table, answers } = answersOf(`Name,Address,Amount\nNorthwind,${A},1\nNo payout,,\nHarbor,,2\nCedar,${C},`);
    expect(payoutRows(table, answers.hasHeader, answers.columns).rows.map((row) => [row.line, row.name, row.address, row.amount])).toEqual([
      [2, "Northwind", A, "1"],
      [4, "Harbor", "", "2"],
      [5, "Cedar", C, ""],
    ]);
    const long = answersOf(["Address,Amount", ...Array.from({ length: PAYOUT_ROWS_MAX + 3 }, (_, index) => `${A},${index + 1}`)].join("\n"));
    const { rows, more } = payoutRows(long.table, true, long.answers.columns);
    expect(rows).toHaveLength(PAYOUT_ROWS_MAX);
    expect(more).toBe(3);
    expect(payoutQuestions(long.table, long.answers)).toMatchObject({ rows: PAYOUT_ROWS_MAX, leftOut: 3 });
    expect(PAYOUT_FILE_MAX_BYTES).toBe(2_000_000);
  });

  it("says what is left to answer before the batch is checked", () => {
    const none = answersOf(`Name,Amount\nNorthwind,10`);
    expect(unansweredPayout(payoutQuestions(none.table, none.answers), none.answers)).toBe("Choose the column for Address.");
    const twice = { ...none.answers, columns: { address: 0, amount: 0 } };
    expect(unansweredPayout(payoutQuestions(none.table, twice), twice)).toBe("Choose a different column for each field.");
    const empty = answersOf("Address,Amount");
    expect(unansweredPayout(payoutQuestions(empty.table, empty.answers), empty.answers)).toBe(
      "The batch has no row with an address or an amount under its column names."
    );
    const fine = answersOf(`Address,Amount\n${A},10.50`);
    expect(unansweredPayout(payoutQuestions(fine.table, fine.answers), fine.answers)).toBeNull();
  });
});

describe("amounts (payout check CP6)", () => {
  it("asks how the amounts are written only when 1,000 could be one thousand or one, as the bill check asks", () => {
    const row = (amount: string) => ({ line: 1, cells: [], address: A, name: "", amount, token: "", tokenType: "" });
    expect(payoutDecimalMark([row("1,000"), row("250")])).toEqual({ mark: null, ask: true, mixed: false });
    expect(payoutDecimalMark([row("1,000"), row("2.50")])).toEqual({ mark: ".", ask: false, mixed: false });
    expect(payoutDecimalMark([row("1.000,5")])).toEqual({ mark: ",", ask: false, mixed: false });
    expect(payoutDecimalMark([row("1,5"), row("2.5")])).toEqual({ mark: null, ask: true, mixed: true });

    const { table, answers } = answersOf(`Address,Amount\n${A},"1,000"\n${B},250`);
    const questions = payoutQuestions(table, answers);
    expect(unansweredPayout(questions, answers)).toBe("Choose how the batch writes its amounts: 1,234.50 or 1.234,50.");
    expect(unansweredPayout(questions, { ...answers, decimalMark: "," })).toBeNull();
    expect(answeredDecimalMark(questions, { ...answers, decimalMark: "," })).toBe(",");
    // A batch that settles it keeps its own mark, whatever was answered before.
    const settled = answersOf(`Address,Amount\n${A},"1,000.50"`);
    expect(answeredDecimalMark(payoutQuestions(settled.table, settled.answers), { ...settled.answers, decimalMark: "," })).toBe(".");
    // Without an amount column there is nothing to ask.
    const addresses = answersOf(`Address\n${A}`);
    expect(payoutQuestions(addresses.table, addresses.answers).decimalMark).toEqual({ mark: null, ask: false, mixed: false });
  });

  it("reads an amount to an exact decimal, its currency symbol or code taken off", () => {
    expect(readPayoutAmount("1,250.50", ".", 6, "USDC")).toEqual({ ok: true, value: "1250.5" });
    expect(readPayoutAmount("1.250,50", ",", 6, "USDC")).toEqual({ ok: true, value: "1250.5" });
    expect(readPayoutAmount("$1,250.00", null, 6, "USDC")).toEqual({ ok: true, value: "1250" });
    expect(readPayoutAmount("100 USDC", null, 6, "USDC")).toEqual({ ok: true, value: "100" });
    expect(readPayoutAmount("0.000001", null, 6, "USDC")).toEqual({ ok: true, value: "0.000001" });
  });

  it("says to fix an amount that is blank, not a number, zero or below zero (payout check CP6)", () => {
    expect(readPayoutAmount("", ".", 6, "USDC")).toEqual({ ok: false, reason: "No amount." });
    expect(readPayoutAmount("ten", ".", 6, "USDC")).toEqual({ ok: false, reason: "Amount “ten” is not a number." });
    expect(readPayoutAmount("1e18", ".", 6, "USDC")).toEqual({ ok: false, reason: "Amount “1e18” is not a number." });
    expect(readPayoutAmount("0", ".", 6, "USDC")).toEqual({ ok: false, reason: "Amount “0” is not above zero." });
    expect(readPayoutAmount("0.000", ".", 6, "USDC")).toEqual({ ok: false, reason: "Amount “0.000” is not above zero." });
    expect(readPayoutAmount("-5", ".", 6, "USDC")).toEqual({ ok: false, reason: "Amount “-5” is below zero." });
    expect(readPayoutAmount("(5.00)", ".", 6, "USDC")).toEqual({ ok: false, reason: "Amount “(5.00)” is below zero." });
    expect(readPayoutAmount("1,000", null, 6, "USDC")).toMatchObject({ ok: false, reason: expect.stringContaining("could be read two ways") });
  });

  it("says to fix an amount with more decimals than its token has, and does not count them for a token the page does not know", () => {
    expect(readPayoutAmount("12.5000001", ".", 6, "USDC on Base")).toEqual({ ok: false, reason: "Amount “12.5000001” has 7 decimals, and USDC on Base has 6." });
    // Trailing zeros are no decimals: 12.5000000 is 12.5.
    expect(readPayoutAmount("12.5000000", ".", 6, "USDC")).toEqual({ ok: true, value: "12.5" });
    expect(readPayoutAmount("1.000000000000000001", ".", 18, "the native coin")).toEqual({ ok: true, value: "1.000000000000000001" });
    expect(readPayoutAmount("1.0000000000000000001", ".", 18, "the native coin")).toEqual({
      ok: false,
      reason: "Amount “1.0000000000000000001” has 19 decimals, and the native coin has 18.",
    });
    expect(readPayoutAmount("1.00000000000000000000001", ".", null, "DAI")).toEqual({ ok: true, value: "1.00000000000000000000001" });
  });

  it("reads an amount of any size: an airdrop of a token with a large supply is not too large (payout check CP6)", () => {
    expect(readPayoutAmount("123456789012345", ".", null, "DAI")).toEqual({ ok: true, value: "123456789012345" });
    expect(readPayoutAmount("100,000,000,000,000,000", ".", 18, "the native coin")).toEqual({ ok: true, value: "100000000000000000" });
  });
});
