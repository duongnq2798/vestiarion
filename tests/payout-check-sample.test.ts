import { describe, expect, it } from "vitest";
import { specialAddress } from "@/lib/address-check";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { checkedPayoutCsv } from "@/lib/payout-check/csv";
import { checkPayouts, payoutCheckWords, type FindingKind } from "@/lib/payout-check/findings";
import { payoutQuestions, readPayoutBatch, startingPayoutAnswers } from "@/lib/payout-check/read";
import { SAMPLE_PAYOUT_FILE, SAMPLE_PAYOUT_SOURCE, samplePayoutBatch } from "@/lib/payout-check/sample";

/**
 * The example batch (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP11), run through the whole check: Safe's
 * CSV Airdrop form, each planned finding on its row and nowhere else, the rows planned clean with nothing found, its
 * listed address on the OFAC snapshot, and every other address made up.
 */

const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const table = readPayoutBatch(samplePayoutBatch());
const answers = startingPayoutAnswers(table);
const check = checkPayouts(table, answers, { sanctioned });

/** What each row of the example is there to show, by its line. */
const PLANNED: Record<number, { name: string; kind: FindingKind | null }> = {
  2: { name: "Northwind Design", kind: "alike_row" },
  3: { name: "Harbor Print Co", kind: "name_addresses" },
  4: { name: "Cedar Coffee Roasters", kind: "same_address" },
  5: { name: "Kestrel Data Ltd", kind: "sanctioned" },
  6: { name: "Orchid Studio", kind: "alike_row" },
  7: { name: "Cedar Coffee Roasters", kind: "same_address" },
  8: { name: "Juniper Office Supply", kind: "checksum" },
  9: { name: "Maple Street Cleaning", kind: "special" },
  10: { name: "Redwood Legal", kind: "amount" },
  11: { name: "Bluebell Print Co", kind: "large_amount" },
  12: { name: "Harbor Print Co", kind: "name_addresses" },
  13: { name: "Pinewood Events", kind: "token_alike" },
  14: { name: "Riverbank Bakery", kind: null },
  15: { name: "Lakeside Freight", kind: null },
};

describe("the example batch (payout check CP11)", () => {
  it("is Safe's CSV Airdrop, with a name column, read with nothing to change and nothing to ask", () => {
    expect(answers).toEqual({ hasHeader: true, columns: { tokenType: 0, token: 1, address: 2, amount: 3, name: 5 }, decimalMark: null });
    expect(payoutQuestions(table, answers)).toMatchObject({ rows: 14, leftOut: 0, decimalMark: { ask: false } });
    expect(SAMPLE_PAYOUT_SOURCE).toContain("made-up");
    expect(SAMPLE_PAYOUT_FILE).toMatch(/\.csv$/);
  });

  it("shows each planned finding on its row and nowhere else, and nothing on the rows planned clean", () => {
    expect(check.results.map((result) => [result.row.line, result.row.name])).toEqual(Object.entries(PLANNED).map(([line, { name }]) => [Number(line), name]));
    for (const result of check.results) {
      const { kind } = PLANNED[result.row.line];
      const kinds = result.findings.map((finding) => finding.kind);
      expect(kinds, `row ${result.row.line}`).toEqual(kind === null ? [] : [kind]);
      expect(result.verdict, `row ${result.row.line}`).toBe(kind === null ? "nothing_found" : result.findings[0].level);
    }
    expect(check.counts).toEqual({ rows: 14, fix: 1, stop: 6, look: 5, nothingFound: 2 });
  });

  it("says what each finding is about, naming the rows it pairs", () => {
    const words = (line: number) => payoutCheckWords(check.results.find((result) => result.row.line === line)!);
    expect(words(2)).toMatch(/^Stop: Made to look like the address on row 6 \(Orchid Studio\)\. It shares its first 4 and last 4 digits/);
    expect(words(3)).toBe("Look: Harbor Print Co is given another address on row 12. Check which one is theirs.");
    expect(words(4)).toBe("Look: The same address, name and amount as row 7: this payment may be in the batch twice.");
    expect(words(5)).toBe(`Stop: On OFAC's SDN list, under ${snapshot.wallets[0].name}.`);
    expect(words(9)).toBe("Stop: This is the USDC on Base token contract, not a wallet.");
    expect(words(10)).toBe("Fix: Amount “1800.0000001” has 7 decimals, and USDC on Base has 6.");
    expect(words(11)).toBe(
      "Look: At least 100 times the median of the other USDC on Base amounts in the batch, 400: a decimal point may have moved, or the amount is written in base units."
    );
    expect(words(13)).toMatch(/^Stop: The token contract is made to look like USDC on Base's: it shares its first 4 and last 4 digits\./);
    expect(words(14)).toBe("Nothing found");
  });

  it("totals its USDC on Base, leaving out the amount to fix, apart from the token made to look like it", () => {
    expect(check.totals.map(({ label, rows, sum }) => [label, rows, sum])).toEqual([
      ["USDC on Base", 12, "405285"],
      ["0x833522497C4013027398e6351d9beA7058412913", 1, "300"],
    ]);
    expect(check.notTotalled).toBe(1);
  });

  it("uses an address on the OFAC snapshot for its listed row, USDC's own contract for the token, and made-up addresses for every other", () => {
    const listed = new Set(snapshot.wallets.map((wallet) => wallet.address));
    const receivers = check.results.map((result) => [result.row.line, result.row.address.toLowerCase()] as const);
    expect(receivers.filter(([, address]) => listed.has(address)).map(([line]) => line)).toEqual([5]);
    expect(receivers.filter(([, address]) => specialAddress(address) !== null).map(([line]) => line)).toEqual([9]);
    expect(specialAddress(check.results[0].row.token)).toEqual({ kind: "token", label: "USDC on Base" });
  });

  it("comes back as a CSV with its verdicts, saying nothing is safe or verified", () => {
    const csv = checkedPayoutCsv(table, answers, check);
    expect(csv.split("\r\n")[0]).toBe(`${String.fromCharCode(0xfeff)}token_type,token_address,receiver,amount,id,name,Payout check`);
    expect(csv).not.toMatch(/safe|verified/i);
  });
});
