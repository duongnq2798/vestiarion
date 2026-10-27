import { beforeAll, describe, expect, it } from "vitest";
import names from "@/lib/data/ofac-sdn-names.json";
import wallets from "@/lib/data/ofac-sdn-evm-wallets.json";
import { columnNames, sampleValues } from "@/lib/bill-import/columns";
import { readTable } from "@/lib/bill-import/table";
import type { SdnNameSnapshot } from "@/lib/sanctioned-wallets";
import {
  checkVendorRows,
  detectVendorColumns,
  EXAMPLE_LIST,
  looksLikeVendorHeader,
  nameNotCompared,
  needsALook,
  readVendorList,
  sdnResultWords,
  VENDOR_ROWS_MAX,
  vendorResultsCsv,
  vendorRows,
  vendorSummary,
  vendorTable,
  walletWords,
  type VendorResult,
} from "@/lib/vendor-check/list";
import { buildNameIndex, type NameIndex } from "@/lib/vendor-check/match";

/**
 * A vendor list through the vendor check (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV2, CV6): read as
 * the bill import reads a list, past title lines above its column names, a list of one column read whole, its columns
 * found by their names, each row's name matched (or not compared, without a word in Latin letters other than legal
 * forms and numbers) and its wallet checked with the address checker's rules, chain prefixes, payment links and
 * currency labels read, against OFAC's addresses and the other rows', then counted and written back as a CSV.
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
  const table = readVendorList(text);
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

  it("reads a one-column list whole, so a name written 'Last, First' stays one name", () => {
    // Excel and Google Sheets copy one column without quoting a cell that holds a comma.
    const pasted = "Vendor\r\nNorthwind Design\r\nPrigozhin, Evgeny\r\nKadyrov, Ramzan";
    expect(readVendorList(pasted).rows.map((row) => row.cells)).toEqual([["Vendor"], ["Northwind Design"], ["Prigozhin, Evgeny"], ["Kadyrov, Ramzan"]]);
    const [, prigozhin, kadyrov] = check(pasted);
    expect(prigozhin.row.name).toBe("Prigozhin, Evgeny");
    expect(prigozhin.matches?.[0]).toMatchObject({ band: "strong" });
    expect(kadyrov.matches?.map((match) => match.entry.number)).toContain(23343);
    // A first row of one cell, and no row of more than two, written without a space too.
    expect(readVendorList("Vendor\nShenzhen Harbor Technology Co.,Ltd.").rows[1].cells).toEqual(["Shenzhen Harbor Technology Co., Ltd."]);
    // A list with columns keeps them.
    expect(readVendorList("Vendor,Country\nAcme GmbH,DE").rows[1].cells).toEqual(["Acme GmbH", "DE"]);
  });

  it("reads a list without column names whose every comma is followed by a space as one column", () => {
    // A CSV never writes a space after the comma between two columns; a name written "Last, First" always has one.
    const results = check("Kadyrov, Ramzan\nPrigozhin, Evgeny\nSmith, John");
    expect(results.map((result) => result.row.name)).toEqual(["Kadyrov, Ramzan", "Prigozhin, Evgeny", "Smith, John"]);
    expect(results[1].matches?.[0]).toMatchObject({ band: "strong" });
    // A comma with no space after it is between two columns, and a row of more than two cells keeps its columns, so a
    // name never takes in a wallet or a phone number.
    expect(readVendorList("Northwind Design, US\nBank Melli Iran,IR").rows[0].cells).toEqual(["Northwind Design", "US"]);
    expect(readVendorList(`Bank Melli Iran, IR, ${NORTHWIND}`).rows[0].cells).toEqual(["Bank Melli Iran", "IR", NORTHWIND]);
    // Column names of more than one cell keep the columns, spaces or not.
    expect(readVendorList("Vendor, Country\nAcme GmbH, DE").rows[1].cells).toEqual(["Acme GmbH", "DE"]);
  });

  it("reads past title lines above the column names, so a listed name and wallet are still checked", () => {
    // Accounting tools put a report's title and dates above its column names, with no comma after them.
    const lazarus = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
    const text = [
      "Vendor Contact List",
      "All Dates",
      "",
      "Vendor,Phone,Email,Wallet",
      "Bank Melli Iran,+98 21 5555 1234,info@bmi.example,",
      `Lazarus Group,,,${lazarus}`,
    ].join("\n");
    const list = readVendorList(text);
    expect(list.titles).toEqual(["Vendor Contact List", "All Dates"]);
    expect(list.rows[0]).toEqual({ line: 4, cells: ["Vendor", "Phone", "Email", "Wallet"] });
    const [melli, group] = check(text);
    expect(melli.row).toMatchObject({ line: 5, name: "Bank Melli Iran", wallet: "" });
    expect(melli.matches?.[0]).toMatchObject({ band: "strong", entry: { number: 25578 } });
    expect(group.matches?.[0]).toMatchObject({ band: "strong", entry: { number: 27307 } });
    expect(walletWords(group.wallet!)).toEqual({ tone: "stop", text: "Do not pay: on OFAC's SDN list, under LAZARUS GROUP." });
    const [titled] = check(`Vendor Contact List\nVendor,Country,Wallet\nBank Melli Iran,IR,${NORTHWIND}`);
    expect(titled.matches?.[0]).toMatchObject({ band: "strong", country: { kind: "agrees" } });
    expect(walletWords(titled.wallet!).tone).toBe("fine");
    // Without column names to find, a title line does not make the list one column.
    expect(readVendorList(`Report\nBank Melli Iran,IR,${NORTHWIND}`)).toMatchObject({ titles: [], rows: [{ cells: ["Report"] }, { cells: ["Bank Melli Iran", "IR", NORTHWIND] }] });
  });

  it("puts a name in the last column back together when the list cut it at its commas, for the page as for the check", () => {
    const list = readVendorList("Country,Vendor\nRU,Kadyrov, Ramzan\nUS,Northwind Design");
    const { rows } = vendorRows(list, true, { country: 0, name: 1 });
    expect(rows[0]).toMatchObject({ name: "Kadyrov, Ramzan", country: "RU", cells: ["RU", "Kadyrov, Ramzan"] });
    expect(rows[1]).toMatchObject({ name: "Northwind Design", cells: ["US", "Northwind Design"] });
    // The columns, what each reads, and the CSV's columns are the list as checked.
    const checked = vendorTable(list, true, { country: 0, name: 1 });
    expect(columnNames(checked, true)).toEqual(["Country", "Vendor"]);
    expect(sampleValues(checked, true, 1)).toEqual(["Kadyrov, Ramzan", "Northwind Design"]);
    // A name column with another after it is left as read.
    expect(vendorTable(list, true, { country: 1, name: 0 })).toBe(list);
    expect(vendorRows(readVendorList("Vendor,Country\nKadyrov, Ramzan,RU"), true, { name: 0, country: 1 }).rows[0].name).toBe("Kadyrov");
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

  it("reads the address in a chain-prefixed wallet or a payment link, so one OFAC lists still stops", () => {
    const listed = LISTED_EVM.address;
    const usdcOnBase = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const results = check(
      `Vendor,Wallet\nA,eth:${listed}\nB,base:${listed}\nC,ethereum:${listed}@1\nD,ethereum:${usdcOnBase}@8453/transfer?address=${listed}&uint256=1e6`
    );
    for (const result of results) {
      expect(walletWords(result.wallet!)).toEqual({ tone: "stop", text: `Read as ${listed}. Do not pay: on OFAC's SDN list, under ${LISTED_EVM.name}.` });
      expect(needsALook(result)).toBe(true);
    }
  });

  it("compares a prefixed wallet with the other rows' too, and gives a cell with 0x that is no address the checker's reason", () => {
    const [northwind, harbor] = check(`Vendor,Wallet\nNorthwind Design,base:${NORTHWIND}\nHarbor Print Co,${LOOKALIKE}`);
    expect(walletWords(harbor.wallet!).text).toBe("Do not pay: made to look like Northwind Design's address. It shares its first 4 and last 4 digits.");
    expect(walletWords(northwind.wallet!).text).toBe(`Read as ${NORTHWIND}. Do not pay: made to look like Harbor Print Co's address. It shares its first 4 and last 4 digits.`);
    const [cut, labelled] = check("Vendor,Wallet\nA,eth:0x7a2d\nB,wallet 0x7a2dc41e9b03");
    expect(walletWords(cut.wallet!)).toEqual({
      tone: "stop",
      text: "Read as 0x7a2d. Not an address. It has 4 characters after 0x; an address has 40. One may have been lost or added in the copy.",
    });
    expect(walletWords(labelled.wallet!).tone).toBe("stop");
  });

  it("looks up another currency's address as written or inside a payment link, a 0x within it being part of it", () => {
    const [bech32, link] = check("Vendor,Wallet\nA,bc1qsxf77cvwcd6jv6j8d8j3uhh4g0xqw4meswmwuc\nB,bitcoin:12aNKp2iDKuhEde2YfPdd4DFGenRUTKupL?amount=0.1");
    expect(walletWords(bech32.wallet!)).toEqual({ tone: "stop", text: "Do not pay: on OFAC's SDN list, under NIKAEEN RAVARI, Amir Hossein (XBT)." });
    expect(walletWords(link.wallet!)).toEqual({ tone: "stop", text: "Do not pay: on OFAC's SDN list, under MESRI, Behzad (XBT)." });
  });

  it("finds a listed address written with its currency, as OFAC writes them ('XBT <address>')", () => {
    const grimm = "1LpYKb3SXZPve9hsH2QEJZFX279wJVGowi";
    const results = check(`Vendor,Wallet\nA,XBT ${grimm}\nB,BTC ${grimm}\nC,${grimm} (BTC)\nD,TRX ${LISTED_TRON}\nE,USDT (TRC20): ${LISTED_TRON}`);
    const [xbt, btc, after, trx, usdt] = results;
    for (const result of [xbt, btc, after]) {
      expect(walletWords(result.wallet!)).toEqual({ tone: "stop", text: "Do not pay: on OFAC's SDN list, under GRIMM, Matthew Simon (XBT)." });
    }
    for (const result of [trx, usdt]) {
      expect(walletWords(result.wallet!)).toEqual({ tone: "stop", text: "Do not pay: on OFAC's SDN list, under BANK MARKAZI JOMHOURI ISLAMI IRAN (TRX)." });
    }
    expect(results.every(needsALook)).toBe(true);
    expect(vendorSummary(results)).toMatchObject({ wallets: 5, walletStops: 5 });
    const [other] = check("Vendor,Wallet\nA,BTC bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    expect(walletWords(other.wallet!).tone).toBe("fine");
  });

  it("reads a payment link that calls a token's transfer by its address= alone, never as its token contract", () => {
    const usdt = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
    const [named, none, plain] = check(
      `Vendor,Wallet\nA,ethereum:${usdt}@1/transfer?address=vendor.eth&uint256=1e6\nB,ethereum:${usdt}@10/transfer\nC,ethereum:${NORTHWIND}@1?value=1e18`
    );
    expect(walletWords(named.wallet!).tone).toBe("stop");
    expect(walletWords(named.wallet!).text).toMatch(/^Read as vendor\.eth\. Not an address\. /);
    expect(walletWords(none.wallet!)).toEqual({ tone: "stop", text: "Not an address to pay: this payment link calls a contract and gives no pay-to address (address=)." });
    // A link with no call pays its own address.
    expect(walletWords(plain.wallet!)).toEqual({ tone: "fine", text: `Read as ${NORTHWIND}. Nothing here says it is wrong.` });
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
    expect(vendorSummary(results)).toEqual({ rows: 5, names: 4, strong: 1, possible: 1, noMatch: 2, notCompared: 0, wallets: 3, walletStops: 2, walletNotes: 0 });
  });

  it("does not compare a name with no word in Latin letters, says so, and counts it apart from no match", () => {
    const results = check("Vendor\nСбербанк России\nBank Melli Iran 中国银行\nNorthwind Design");
    const [cyrillic, mixed, plain] = results;
    expect(cyrillic.matches).toEqual([]);
    expect(cyrillic.notLatin).toEqual(["Сбербанк", "России"]);
    expect(needsALook(cyrillic)).toBe(true);
    expect(sdnResultWords(cyrillic)).toBe("Not compared: not in Latin letters");
    // Its words in Latin letters are compared; the others are named as left out.
    expect(mixed.notLatin).toEqual(["中国银行"]);
    expect(sdnResultWords(mixed)).toBe("Strong match (left out, not in Latin letters: 中国银行)");
    expect(plain.notLatin).toEqual([]);
    expect(needsALook(plain)).toBe(false);
    expect(vendorSummary(results)).toMatchObject({ names: 3, strong: 1, possible: 0, noMatch: 1, notCompared: 1 });
  });

  it("does not compare a name in another script whose only words in Latin letters are legal forms or numbers", () => {
    // "Co., Ltd." in a one-column list stays in its name.
    const results = check("Vendor\nСбербанк PJSC\n华为技术 Co., Ltd.\nРоснефть LLC\nСбербанк 2");
    for (const result of results) {
      expect(result.matches, result.row.name).toEqual([]);
      expect(nameNotCompared(result), result.row.name).toBe(true);
      expect(sdnResultWords(result)).toBe("Not compared: not in Latin letters");
    }
    expect(results[1].row.name).toBe("华为技术 Co., Ltd.");
    expect(vendorSummary(results)).toMatchObject({ names: 4, noMatch: 0, notCompared: 4 });
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
