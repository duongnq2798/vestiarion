import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOSE_PACK_COLUMNS, closePackTable, type ClosePackColumn } from "@/lib/close-pack/export";
import { closePackMonth } from "@/lib/close-pack/month";
import {
  PAYMENTS_TAB,
  SHEET_NUMBER_COLUMNS,
  SPREADSHEET_ID,
  SUMMARY_TAB,
  columnLetter,
  exporterWords,
  monthTag,
  paymentsSha256,
  sheetValues,
  spreadsheetTitle,
  spreadsheetUrl,
  summaryValues,
  type SheetCell,
} from "@/lib/googlesheets/table";
import { samplePack } from "./support/close-pack-fixtures";

/**
 * The close pack as a spreadsheet (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md GS7-GS10): the
 * Payments tab is the close pack's table with six columns as numbers when they round trip and every other cell the text
 * it was, never a formula; its SHA-256 is of the rows as written, which a read back hashes the same once padded; the
 * Summary tab's rows come from the pack, in order; and the title, the link and the month's tag are built from checked
 * values only.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const SHA = "ab".repeat(32);
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000a6c01";
const ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";

/** A table of one row, every cell empty but the ones given. */
function oneRow(cells: Partial<Record<ClosePackColumn, string>>) {
  return { columns: CLOSE_PACK_COLUMNS, rows: [CLOSE_PACK_COLUMNS.map((column) => cells[column] ?? "")] };
}
const cell = (values: SheetCell[][], column: ClosePackColumn, row = 1) => values[row][CLOSE_PACK_COLUMNS.indexOf(column)];

describe("the tabs (close pack Sheets GS7)", () => {
  it("are Payments and Summary", () => {
    expect(PAYMENTS_TAB).toBe("Payments");
    expect(SUMMARY_TAB).toBe("Summary");
  });
});

describe("sheetValues (close pack Sheets GS8)", () => {
  it("starts with the close pack's columns as the header", () => {
    const values = sheetValues(closePackTable(samplePack(), { origin: ORIGIN }));
    expect(values[0]).toEqual([...CLOSE_PACK_COLUMNS]);
    expect(values).toHaveLength(4);
    for (const row of values) expect(row).toHaveLength(51);
  });

  it("writes the six amount and count columns as numbers when they round trip, and leaves the rest as text", () => {
    expect(SHEET_NUMBER_COLUMNS).toEqual(["bill_amount", "amount_paid", "discount", "network_fee_usd", "route_fee_usdc", "earlier_attempts"]);
    const values = sheetValues(
      oneRow({
        amount_paid: "1250.500000",
        bill_amount: "1250.500000",
        discount: "",
        network_fee_usd: "1234567890123.000000",
        route_fee_usdc: "0.120000",
        earlier_attempts: "2",
        entry_seq: "5619",
        invoice_number: "00123",
        paid_at: "2026-10-02T14:00:05.000Z",
        due_date: "2026-10-15",
      })
    );
    expect(cell(values, "amount_paid")).toBe(1250.5);
    expect(cell(values, "bill_amount")).toBe(1250.5);
    expect(cell(values, "discount")).toBe("");
    // Thirteen digits: not one of the amounts a number holds exactly here.
    expect(cell(values, "network_fee_usd")).toBe("1234567890123.000000");
    expect(cell(values, "route_fee_usdc")).toBe(0.12);
    expect(cell(values, "earlier_attempts")).toBe(2);
    expect(cell(values, "entry_seq")).toBe("5619");
    expect(cell(values, "invoice_number")).toBe("00123");
    expect(cell(values, "paid_at")).toBe("2026-10-02T14:00:05.000Z");
    expect(cell(values, "due_date")).toBe("2026-10-15");
  });

  it("keeps the exact decimal whenever a number would not hold it", () => {
    const values = sheetValues(
      oneRow({ amount_paid: "999999999999.999999", bill_amount: "1250.5", discount: "-1.000000", network_fee_usd: "1e3", earlier_attempts: "1234567", route_fee_usdc: "0001.000000" })
    );
    expect(cell(values, "amount_paid")).toBe("999999999999.999999");
    expect(cell(values, "bill_amount")).toBe("1250.5");
    expect(cell(values, "discount")).toBe("-1.000000");
    expect(cell(values, "network_fee_usd")).toBe("1e3");
    expect(cell(values, "earlier_attempts")).toBe("1234567");
    expect(cell(values, "route_fee_usdc")).toBe("0001.000000");
  });

  it("leaves a cell that would be a formula as the text it is, with nothing added", () => {
    const values = sheetValues(oneRow({ payee: '=HYPERLINK("x")', invoice_number: "+1", po_reference: "-2", decided: "@SUM(A1)", amount_paid: "=1+1" }));
    expect(cell(values, "payee")).toBe('=HYPERLINK("x")');
    expect(cell(values, "invoice_number")).toBe("+1");
    expect(cell(values, "po_reference")).toBe("-2");
    expect(cell(values, "decided")).toBe("@SUM(A1)");
    expect(cell(values, "amount_paid")).toBe("=1+1");
    expect(JSON.stringify(values)).not.toContain("'=");
  });
});

describe("paymentsSha256 (close pack Sheets GS10)", () => {
  const values = sheetValues(closePackTable(samplePack(), { origin: ORIGIN }));

  it("is the SHA-256 of JSON.stringify of the rows, each padded to 51 cells", () => {
    const expected = createHash("sha256").update(JSON.stringify(values), "utf8").digest("hex");
    expect(paymentsSha256(values)).toBe(expected);
    expect(paymentsSha256(values)).toMatch(/^[0-9a-f]{64}$/);
    const short = [["a", 1]];
    expect(paymentsSha256(short)).toBe(createHash("sha256").update(JSON.stringify([["a", 1, ...Array(49).fill("")]]), "utf8").digest("hex"));
  });

  it("hashes a read back the same once padded, though Google drops trailing empty cells", () => {
    const written = [...values, sheetValues(oneRow({ paid_at: "2026-10-03T10:00:00.000Z", payment_id: "pay-x", amount_paid: "5.000000" }))[1]];
    const readBack = written.map((row) => {
      const cells = [...row];
      while (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
      return cells;
    });
    expect(readBack[readBack.length - 1]).toHaveLength(CLOSE_PACK_COLUMNS.indexOf("amount_paid") + 1);
    expect(paymentsSha256(readBack)).toBe(paymentsSha256(written));
  });

  it("changes with one changed cell", () => {
    const changed = values.map((row) => [...row]);
    changed[2][CLOSE_PACK_COLUMNS.indexOf("amount_paid")] = 1250.01;
    expect(paymentsSha256(changed)).not.toBe(paymentsSha256(values));
    const asText = values.map((row) => [...row]);
    asText[1][CLOSE_PACK_COLUMNS.indexOf("amount_paid")] = "100";
    expect(paymentsSha256(asText)).not.toBe(paymentsSha256(values));
  });
});

describe("exporterWords (close pack Sheets GS9)", () => {
  it("is the exporter's email, or a member named by 8 characters of their id", () => {
    expect(exporterWords({ id: "0b6c1c9e-0000-4000-8000-00000000a003", email: "accountant@firm.test" })).toBe("accountant@firm.test");
    expect(exporterWords({ id: "1a2b3c4d-0000-4000-8000-00000000a003", email: null })).toBe("a member (1a2b3c4d)");
  });
});

describe("summaryValues (close pack Sheets GS9)", () => {
  const HOW = [
    [
      "How to check it",
      "Each row of Payments names the signed ledger entry that records its payment: entry_seq, entry_hash, signature and signing_key_id. Download the month's signed JSON from the close pack page and check any entry with verifyLedgerEntry from @vestiarion/sdk, with the public keys in that file.",
    ],
    [
      "",
      "Vestiarion read the Payments tab back after writing it, and recorded this export in the workspace's ledger as close_pack_exported, with this spreadsheet's id and the SHA-256 above. Find it in the Audit log.",
    ],
    ["", "The SHA-256 is of the Payments tab as written: JSON.stringify of its rows, the header first, each row as wide as the header, with empty cells as empty text."],
    ["", "A change made in this spreadsheet after the export is not in the ledger. Export the month again to write it afresh."],
  ];

  it("writes every row of the month, in order, from the pack", () => {
    expect(summaryValues(samplePack(), { origin: ORIGIN, sha256: SHA, exportedBy: "accountant@firm.test" })).toEqual([
      ["Vestiarion monthly close pack", ""],
      ["Workspace", "Pinecrest Studio (pinecrest-studio)"],
      ["Network", "Arc testnet"],
      ["Month", "October 2026, a calendar month in UTC"],
      ["Read at", "2026-11-02 09:00 UTC"],
      ["Exported by", "accountant@firm.test"],
      ["Payments settled", 3],
      ["Paid in USDC", 1650],
      ["Route fees in USDC", 0.12],
      ["Not settled in the month", "1: listed on the close pack page, not in this spreadsheet"],
      ["Escrow moves", "1: listed on the close pack page, not in this spreadsheet"],
      ["Signed entries verified", "12 of 12"],
      ["Ledger head", "#99 h99"],
      ["Signing keys", "1a2b3c4d5e6f7a8b"],
      ["Payments tab SHA-256", SHA],
      ["Close pack page", "https://www.vestiarion.xyz/o/pinecrest-studio/evidence/close-pack?month=2026-10"],
      ...HOW,
    ]);
  });

  it("names Arc mainnet from the profile, and says so far for a month not ended", () => {
    const now = new Date("2026-10-25T14:03:00Z");
    const pack = samplePack({ network: "arc-mainnet", now, month: closePackMonth("2026-10", now)! });
    const rows = summaryValues(pack, { origin: `${ORIGIN}/`, sha256: SHA, exportedBy: "a member (1a2b3c4d)" });
    const value = (label: string) => rows.find((row) => row[0] === label)?.[1];
    expect(value("Network")).toBe("Arc mainnet");
    expect(value("Month")).toBe("October 2026 so far, a calendar month in UTC");
    expect(value("Read at")).toBe("2026-10-25 14:03 UTC");
    expect(value("Exported by")).toBe("a member (1a2b3c4d)");
    expect(value("Close pack page")).toBe("https://www.vestiarion.xyz/o/pinecrest-studio/evidence/close-pack?month=2026-10");
  });

  it("gives one Paid in row per token, never a sum of USDC and EURC, route fees only above zero, and simulated payments apart", () => {
    const pack = samplePack();
    const mixed = {
      ...pack,
      ledgerHead: null,
      keys: [...pack.keys, { ...pack.keys[0], id: "9f8e7d6c5b4a3210" }],
      totals: {
        ...pack.totals,
        onChain: [
          { token: "USDC" as const, payments: 2, amount: "1250.500000", routeFeesUsdc: "0.000000" },
          { token: "EURC" as const, payments: 1, amount: "99.990000", routeFeesUsdc: "0.000000" },
        ],
        simulated: [
          { token: "USDC" as const, payments: 2, amount: "30.000000", routeFeesUsdc: "0.000000" },
          { token: "EURC" as const, payments: 1, amount: "5.000000", routeFeesUsdc: "0.000000" },
        ],
      },
    };
    const rows = summaryValues(mixed, { origin: ORIGIN, sha256: SHA, exportedBy: "x@y.test" });
    const labels = rows.map((row) => row[0]);
    expect(rows.filter((row) => String(row[0]).startsWith("Paid in"))).toEqual([
      ["Paid in USDC", 1250.5],
      ["Paid in EURC", 99.99],
    ]);
    expect(labels.some((label) => String(label).startsWith("Route fees"))).toBe(false);
    expect(rows.filter((row) => String(row[0]).startsWith("Simulated"))).toEqual([
      ["Simulated, in USDC", "2 payments, 30.000000"],
      ["Simulated, in EURC", "1 payment, 5.000000"],
    ]);
    expect(rows.find((row) => row[0] === "Ledger head")?.[1]).toBe("None");
    expect(rows.find((row) => row[0] === "Signing keys")?.[1]).toBe("1a2b3c4d5e6f7a8b, 9f8e7d6c5b4a3210");
    expect(JSON.stringify(rows)).not.toMatch(/1350\.49|USDC and EURC|USDC plus EURC/);
  });

  it("adds the cut, people and screening rows only when they apply, before how to check it", () => {
    expect(summaryValues(samplePack(), { origin: ORIGIN, sha256: SHA, exportedBy: "x@y.test" }).map((row) => row[0])).not.toEqual(expect.arrayContaining(["Cut", "People", "Screening"]));
    const pack = { ...samplePack(), cut: true, unread: ["members", "screening"] as Array<"members" | "screening"> };
    const rows = summaryValues(pack, { origin: ORIGIN, sha256: SHA, exportedBy: "a member (1a2b3c4d)" });
    const at = (label: string) => rows.findIndex((row) => row[0] === label);
    expect(rows[at("Cut")][1]).toBe("This month has more than 2,000 payments, so this spreadsheet holds the first 2,000. The audit export holds every entry.");
    expect(rows[at("People")][1]).toBe("Members could not be read just now, so people are named by the first 8 characters of their id.");
    expect(rows[at("Screening")][1]).toBe("Some screening records could not be read just now. Those payments say so.");
    expect(at("Close pack page")).toBeLessThan(at("Cut"));
    expect(at("Cut")).toBeLessThan(at("People"));
    expect(at("People")).toBeLessThan(at("Screening"));
    expect(at("Screening")).toBeLessThan(at("How to check it"));
    const peopleOnly = summaryValues({ ...samplePack(), unread: ["members"] }, { origin: ORIGIN, sha256: SHA, exportedBy: "x" }).map((row) => row[0]);
    expect(peopleOnly).toContain("People");
    expect(peopleOnly).not.toContain("Screening");
    expect(peopleOnly).not.toContain("Cut");
  });

  it("is two cells a row, strings and numbers only", () => {
    for (const row of summaryValues(samplePack(), { origin: ORIGIN, sha256: SHA, exportedBy: "x" })) {
      expect(row).toHaveLength(2);
      for (const value of row) expect(["string", "number"]).toContain(typeof value);
    }
  });
});

describe("spreadsheetTitle (close pack Sheets GS7)", () => {
  it("names the product, the workspace, the month and the network", () => {
    expect(spreadsheetTitle(samplePack())).toBe("Vestiarion close pack · Pinecrest Studio · October 2026 · Arc testnet");
  });

  it("says so far for a month not ended", () => {
    const now = new Date("2026-10-25T14:03:00Z");
    expect(spreadsheetTitle(samplePack({ now, month: closePackMonth("2026-10", now)! }))).toBe("Vestiarion close pack · Pinecrest Studio · October 2026 so far · Arc testnet");
  });

  it("is cut to 200 characters", () => {
    const title = spreadsheetTitle(samplePack({ workspace: { slug: "long", name: "N".repeat(300) } }));
    expect(title).toHaveLength(200);
    expect(title.startsWith("Vestiarion close pack · NNN")).toBe(true);
  });
});

describe("spreadsheetUrl and SPREADSHEET_ID (close pack Sheets GS12)", () => {
  it("links a checked id to Google's editor", () => {
    expect(spreadsheetUrl(ID)).toBe(`https://docs.google.com/spreadsheets/d/${ID}/edit`);
    expect(SPREADSHEET_ID.test(ID)).toBe(true);
  });

  it("throws for anything that is not an id", () => {
    for (const bad of ["../x", "a b", "abcdefghij", `https://evil.test/${ID}`, `${ID}/../../x`, `${ID}?x=1`, "x".repeat(101), ""]) {
      expect(() => spreadsheetUrl(bad), bad).toThrow();
    }
  });
});

describe("columnLetter and monthTag (close pack Sheets GS7, GS8)", () => {
  it("names columns as Sheets does", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(26)).toBe("Z");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(51)).toBe("AY");
    expect(columnLetter(CLOSE_PACK_COLUMNS.length)).toBe("AY");
  });

  it("tags the month's file with the workspace's id and the month", () => {
    expect(monthTag(ORG, closePackMonth("2026-10", new Date("2026-11-02T00:00:00Z"))!)).toBe(`${ORG}:2026-10`);
    expect(() => monthTag("x' or name contains '", closePackMonth("2026-10", new Date("2026-11-02T00:00:00Z"))!)).toThrow();
  });
});
