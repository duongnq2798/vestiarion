import { beforeAll, describe, expect, it } from "vitest";
import names from "@/lib/data/ofac-sdn-names.json";
import wallets from "@/lib/data/ofac-sdn-evm-wallets.json";
import { readTable } from "@/lib/bill-import/table";
import type { SdnNameSnapshot } from "@/lib/sanctioned-wallets";
import {
  checkVendorRows,
  detectVendorColumns,
  EXAMPLE_LIST,
  looksLikeVendorHeader,
  VENDOR_ROWS_MAX,
  vendorResultsCsv,
  vendorRows,
  vendorSummary,
  walletWords,
  type VendorResult,
} from "@/lib/vendor-check/list";
import { buildNameIndex, type NameIndex } from "@/lib/vendor-check/match";

/**
 * A vendor list through the vendor check (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV6): read as the
 * bill import reads a list, its columns found by their names, each row's name matched and its wallet checked with the
 * address checker's rules against OFAC's addresses and the other rows', then counted and written back as a CSV.
 */

let index: NameIndex;
beforeAll(() => {
  index = buildNameIndex(names as unknown as SdnNameSnapshot);
});

const NORTHWIND = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
/** Northwind's first 4 and last 4 digits, and nothing else: made to look like it. */
const LOOKALIKE = "0x7a2d8f06c3e1b9a457d02c6e8f1b3a9d4e7ce10d";
const LISTED_EVM = wallets.wallets[0];
const LISTED_TRON = "TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81";

function check(text: string): VendorResult[] {
  const table = readTable(text);
  const hasHeader = looksLikeVendorHeader(table.rows[0].cells);
  const columns = detectVendorColumns(hasHeader ? table.rows[0].cells : [], hasHeader);
  return checkVendorRows(index, vendorRows(table, hasHeader, columns).rows);
}

describe("reading a list (CV6)", () => {
  it("finds the name, country and wallet columns by the names businesses give them", () => {
    expect(detectVendorColumns(["Vendor", "Amount", "Country", "Wallet address"], true)).toEqual({ name: 0, country: 2, wallet: 3 });
    expect(detectVendorColumns(["Supplier name", "Payout address"], true)).toEqual({ name: 0, wallet: 1 });
    expect(detectVendorColumns(["Beneficiary", "Jurisdiction", "Pay-to address"], true)).toEqual({ name: 0, country: 1, wallet: 2 });
    expect(detectVendorColumns(["Company", "Country code", "USDC address"], true)).toEqual({ name: 0, country: 1, wallet: 2 });
    expect(looksLikeVendorHeader(["Vendor", "Country"])).toBe(true);
    expect(looksLikeVendorHeader(["Northwind Design", "US"])).toBe(false);
    // Without column names, the names are in the first column.
    expect(detectVendorColumns([], false)).toEqual({ name: 0 });
  });

  it("reads pasted rows and semicolon CSVs, skips the header and rows with neither a name nor a wallet", () => {
    const table = readTable("Vendor\tCountry\tWallet\nNorthwind Design\tUS\t\n\t\t\n\tGB\t\nHarbor Print Co\t\t" + NORTHWIND);
    const { rows, more } = vendorRows(table, true, { name: 0, country: 1, wallet: 2 });
    expect(more).toBe(0);
    expect(rows).toEqual([
      { line: 2, cells: ["Northwind Design", "US", ""], name: "Northwind Design", country: "US", wallet: "" },
      { line: 5, cells: ["Harbor Print Co", "", NORTHWIND], name: "Harbor Print Co", country: "", wallet: NORTHWIND },
    ]);
    const semicolon = readTable("Supplier;Country\nAcme GmbH;DE");
    expect(vendorRows(semicolon, true, { name: 0, country: 1 }).rows[0]).toMatchObject({ name: "Acme GmbH", country: "DE", wallet: "" });
  });

  it(`reads at most ${VENDOR_ROWS_MAX} rows and says how many more were left out`, () => {
    const text = ["Vendor", ...Array.from({ length: VENDOR_ROWS_MAX + 3 }, (_, at) => `Vendor ${at}`)].join("\n");
    const { rows, more } = vendorRows(readTable(text), true, { name: 0 });
    expect(rows).toHaveLength(VENDOR_ROWS_MAX);
    expect(more).toBe(3);
  });
});

describe("checking a list (CV6)", () => {
  it("matches each row's name, with its country", () => {
    const [melli, northwind] = check("Vendor,Country\nBank Melli Iran,IR\nNorthwind Design,US");
    expect(melli.matches?.[0]).toMatchObject({ band: "strong", entry: { number: 25578 }, country: { kind: "agrees" } });
    expect(northwind.matches).toEqual([]);
    expect(northwind.wallet).toBeNull();
  });

  it("stops at a wallet made to look like another row's, naming that row, on both rows", () => {
    const [northwind, harbor] = check(`Vendor,Wallet\nNorthwind Design,${NORTHWIND}\nHarbor Print Co,${LOOKALIKE}`);
    expect(walletWords(harbor.wallet!)).toEqual({ tone: "stop", text: "Do not pay: made to look like Northwind Design's address. It shares its first 4 and last 4 digits." });
    expect(walletWords(northwind.wallet!)).toEqual({ tone: "stop", text: "Do not pay: made to look like Harbor Print Co's address. It shares its first 4 and last 4 digits." });
  });

  it("notes the same wallet under two names, and calls a row without a name by its row number", () => {
    const [, second] = check(`Vendor,Wallet\nNorthwind Design,${NORTHWIND}\n,${NORTHWIND.toUpperCase().replace("0X", "0x")}`);
    expect(second.matches).toBeNull();
    expect(walletWords(second.wallet!)).toEqual({ tone: "note", text: "The same address as Northwind Design's. Check one wallet is meant for both." });
    const [first] = check(`Vendor,Wallet\nNorthwind Design,${NORTHWIND}\n,${NORTHWIND}`);
    expect(walletWords(first.wallet!).text).toBe("The same address as row 3's. Check one wallet is meant for both.");
  });

  it("stops at an address OFAC lists, EVM or not, naming the entry", () => {
    const [evm, tron, other] = check(`Vendor,Wallet\nA,${LISTED_EVM.address}\nB,${LISTED_TRON}\nC,bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq`);
    expect(walletWords(evm.wallet!)).toEqual({ tone: "stop", text: `Do not pay: on OFAC's SDN list, under ${LISTED_EVM.name}.` });
    expect(walletWords(tron.wallet!)).toEqual({ tone: "stop", text: "Do not pay: on OFAC's SDN list, under BANK MARKAZI JOMHOURI ISLAMI IRAN (TRX)." });
    expect(walletWords(other.wallet!)).toEqual({ tone: "fine", text: "Not among the addresses on OFAC's SDN list. It is not an EVM address, so nothing else was checked." });
  });

  it("gives the address checker's other reasons: a checksum, a token contract, not an address yet, or nothing wrong", () => {
    const mixed = "0x7A2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
    const [checksum, token, short, fine] = check(`Vendor,Wallet\nA,${mixed}\nB,0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\nC,0x7a2d\nD,0x${"12".repeat(20)}`);
    expect(walletWords(checksum.wallet!)).toEqual({ tone: "stop", text: "Do not pay: its checksum does not match (EIP-55), so a character was mistyped or changed." });
    expect(walletWords(token.wallet!)).toEqual({ tone: "stop", text: "Do not pay: this is the USDC on Base token contract, not a wallet." });
    expect(walletWords(short.wallet!)).toEqual({ tone: "stop", text: "Not an address. It has 4 characters after 0x; an address has 40. One may have been lost or added in the copy." });
    expect(walletWords(fine.wallet!)).toEqual({ tone: "fine", text: "Nothing here says it is wrong." });
  });

  it("counts what it found", () => {
    const results = check(`Vendor,Wallet\nBank Melli Iran,\nGolden Star Logistics,\nNorthwind Design,${NORTHWIND}\nHarbor Print Co,${LOOKALIKE}\n,0x${"12".repeat(20)}`);
    expect(vendorSummary(results)).toEqual({ rows: 5, names: 4, strong: 1, possible: 1, noMatch: 2, wallets: 3, walletStops: 2, walletNotes: 0 });
  });

  it("checks the example list: one name on OFAC's list and one wallet made to look like another row's", () => {
    const results = check(EXAMPLE_LIST);
    expect(vendorSummary(results)).toMatchObject({ strong: 1, possible: 0, walletStops: 2 });
  });
});

describe("the results as a CSV (CV6)", () => {
  it("writes the list as read with four columns added, guarding cells a spreadsheet would run", () => {
    const text = `Vendor,Country,Wallet\nBank Melli Iran,IR,\n=1+2,US,\nNorthwind Design,US,${NORTHWIND}`;
    const table = readTable(text);
    const results = checkVendorRows(index, vendorRows(table, true, { name: 0, country: 1, wallet: 2 }).rows);
    const csv = vendorResultsCsv(table.rows[0].cells, results, "2026-10-28");
    expect(csv.startsWith(String.fromCharCode(0xfeff))).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe("Vendor,Country,Wallet,OFAC SDN result,Possible matches,Wallet result,SDN list as of");
    expect(lines[1]).toMatch(/^Bank Melli Iran,IR,,Strong match,"BANK MELLI IRAN \(entry 25578, score 1\.00, IRAN; SDGT; IFSR\)/);
    expect(lines[1].endsWith(",,2026-10-28")).toBe(true);
    expect(lines[2]).toBe("'=1+2,US,,No match,,,2026-10-28");
    expect(lines[3]).toBe(`Northwind Design,US,${NORTHWIND},No match,,Nothing here says it is wrong.,2026-10-28`);
    expect(lines[4]).toBe("");
  });
});
