import { describe, expect, it } from "vitest";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { checkedPayoutCsv, checkedPayoutFileName, PAYOUT_CHECK_COLUMN } from "@/lib/payout-check/csv";
import { checkPayouts } from "@/lib/payout-check/findings";
import { PAYOUT_ROWS_MAX, readPayoutBatch, startingPayoutAnswers, type PayoutAnswers } from "@/lib/payout-check/read";

/**
 * The batch back with a verdict on each row (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP10): every row
 * as the batch wrote it, its column names first when it has them, one column added, a byte-order mark, a semicolon
 * batch kept in semicolons and any other written with commas, and rows past the limit said to be unchecked. Read back,
 * it is the same batch with the one column more.
 */

const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const NORTHWIND = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
const LOOKALIKE = "0x7a2d8f06c3e1b9a457d02c6e8f1b3a9d4e7ce10d";
const B = "0x562acedfa970dc60f109f21c66507b752413f4fb";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const BOM = String.fromCharCode(0xfeff);

const checked = (text: string, change: Partial<PayoutAnswers> = {}) => {
  const table = readPayoutBatch(text);
  const answers = { ...startingPayoutAnswers(table), ...change };
  return { table, answers, csv: checkedPayoutCsv(table, answers, checkPayouts(table, answers, { sanctioned })) };
};
const linesOf = (csv: string) => {
  expect(csv.startsWith(BOM)).toBe(true);
  expect(csv.endsWith("\r\n")).toBe(true);
  return csv.slice(1, -2).split("\r\n");
};

describe("the batch back with a verdict column (payout check CP10)", () => {
  it("writes every row as the batch wrote it, its column names first, and one column added", () => {
    const { csv } = checked(`token_type,token_address,receiver,amount,id\nerc20,${USDC},${NORTHWIND},10,\nerc20,${USDC},${LOOKALIKE},12.5,\nerc20,${USDC},${B},0,\nerc20,USDC,${B},1,`);
    expect(linesOf(csv)).toEqual([
      `token_type,token_address,receiver,amount,id,${PAYOUT_CHECK_COLUMN}`,
      `erc20,${USDC},${NORTHWIND},10,,"Stop: Made to look like the address on row 3. It shares its first 4 and last 4 digits, which a random address does about once in 4.3 billion: one of the two is very likely not the payee's."`,
      `erc20,${USDC},${LOOKALIKE},12.5,,"Stop: Made to look like the address on row 2. It shares its first 4 and last 4 digits, which a random address does about once in 4.3 billion: one of the two is very likely not the payee's."`,
      `erc20,${USDC},${B},0,,"Fix: Amount “0” is not above zero. Look: The same address as row 5, for another amount: it is paid more than once in the batch."`,
      // Safe's erc20 row names its token by its contract, never by a symbol.
      `erc20,USDC,${B},1,,"Fix: The token contract is not an address. An address starts with 0x. Look: The same address as row 4, for another amount: it is paid more than once in the batch."`,
    ]);
    expect(PAYOUT_CHECK_COLUMN).toBe("Payout check");
  });

  it("keeps a semicolon batch's semicolons, and writes a pasted, tab-separated or Disperse batch with commas, quoting what needs it", () => {
    expect(linesOf(checked(`Name;Address;Amount\nHarbor Print, Co;${NORTHWIND};1.234,50`).csv)).toEqual([
      "Name;Address;Amount;Payout check",
      `Harbor Print, Co;${NORTHWIND};1.234,50;Nothing found`,
    ]);
    expect(linesOf(checked(`Name\tAddress\tAmount\nHarbor Print, Co\t${NORTHWIND}\t"1,234.50"`).csv)).toEqual([
      "Name,Address,Amount,Payout check",
      `"Harbor Print, Co",${NORTHWIND},"1,234.50",Nothing found`,
    ]);
    // A Disperse list has no column names, so none comes back.
    expect(linesOf(checked(`${NORTHWIND} 1.5\n${B}=2`).csv)).toEqual([`${NORTHWIND},1.5,Nothing found`, `${B},2,Nothing found`]);
  });

  it("leaves the column empty on a row the check skips, and says a row past the limit was not checked", () => {
    // Addresses scattered as real ones are: 5 hashes of the row's number, 8 hex digits each.
    const address = (index: number) =>
      `0x${[1, 2, 3, 4, 5].map((salt) => (Math.imul(index + 1, 2654435761 + salt * 40503) >>> 0).toString(16).padStart(8, "0")).join("")}`;
    const rows = Array.from({ length: PAYOUT_ROWS_MAX + 1 }, (_, index) => `Payee ${index + 1},${address(index)},1`);
    const lines = linesOf(checked(["Name,Address,Amount", "No payout,,", ...rows].join("\n")).csv);
    expect(lines).toHaveLength(PAYOUT_ROWS_MAX + 3);
    expect(lines[1]).toBe("No payout,,,");
    expect(lines.slice(2, -1).every((line) => /,1,(Nothing found|"?Look: |"?Stop: )/.test(line))).toBe(true);
    expect(lines.at(-1)).toBe(`${rows.at(-1)},"Not checked: only the first 5,000 rows are checked."`);
  });

  it("reads back as the same batch with one column more, which the check does not take for a field", () => {
    const text = `Name,Address,Amount\n"Harbor Print, Co",${NORTHWIND},10\nOrchid,${LOOKALIKE},"1,250.00"\nCedar,northwind.eth,5`;
    const { table, answers, csv } = checked(text);
    const back = readPayoutBatch(csv.slice(1));
    expect(back.rows.map((row) => row.cells.slice(0, -1))).toEqual(table.rows.map((row) => row.cells));
    expect(back.rows.map((row) => row.cells.at(-1))).toEqual([
      "Payout check",
      expect.stringMatching(/^Stop: Made to look like the address on row 3 \(Orchid\)\./),
      expect.stringMatching(/^Stop: Made to look like the address on row 2 \(Harbor Print, Co\)\./),
      "Look: Not checked: an ENS name is not looked up here. Check the address it points to on the day you pay.",
    ]);
    expect(startingPayoutAnswers(back)).toEqual(answers);
  });

  it("names the file as the batch's own, said to be checked", () => {
    expect(checkedPayoutFileName("June payouts.csv")).toBe("June-payouts-checked.csv");
    expect(checkedPayoutFileName("airdrop.tsv")).toBe("airdrop-checked.csv");
  });
});
