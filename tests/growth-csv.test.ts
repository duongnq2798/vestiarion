import { describe, expect, it } from "vitest";
import { csvCell, dedupeKey, LEAD_CSV_HEADERS, LEADS_CSV_TEMPLATE, LeadsCsvError, leadsToCsv, previewLeadsCsv } from "@/lib/growth/csv";
import { rowsFromCsv } from "@/lib/invoice-csv";

/**
 * Leads to and from a CSV (src/lib/growth/csv.ts): the exact header, every row checked, duplicates reported and never
 * overwritten, rows landing as needing review at discovered or verified, and an export a spreadsheet cannot run.
 */

const HEADER = LEAD_CSV_HEADERS.join(",");

/** A CSV line with these columns set and the rest blank. */
function line(values: Partial<Record<(typeof LEAD_CSV_HEADERS)[number], string>>): string {
  return LEAD_CSV_HEADERS.map((header) => {
    const value = values[header] ?? "";
    return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  }).join(",");
}

const csv = (...lines: string[]) => [HEADER, ...lines].join("\n");
const NONE = new Set<string>();

describe("dedupeKey", () => {
  it("is the lower-case host without www., else the lower-case trimmed name", () => {
    expect(dedupeKey("Acme", "https://WWW.Acme.example/about?x=1")).toBe("acme.example");
    expect(dedupeKey("Acme", "http://studio.acme.example")).toBe("studio.acme.example");
    expect(dedupeKey("  Acme   Studio ", null)).toBe("acme studio");
    expect(dedupeKey("Acme", "not a url")).toBe("acme");
  });
});

describe("previewLeadsCsv", () => {
  it("accepts the template, the header in any order", () => {
    const rows = previewLeadsCsv(LEADS_CSV_TEMPLATE, NONE, NONE);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ line: 2, status: "new", lead: { business_name: "Northwind Studio", dedupe_key: "northwind.example", stage: "verified", source: "signal_outbound" } });

    const reversed = [...LEAD_CSV_HEADERS].reverse();
    const values = Object.fromEntries(LEAD_CSV_HEADERS.map((header) => [header, ""])) as Record<string, string>;
    values.business_name = "Reversed Co";
    values.source = "inbound";
    const file = `${reversed.join(",")}\n${reversed.map((header) => values[header]).join(",")}`;
    expect(previewLeadsCsv(file, NONE, NONE)[0]).toMatchObject({ status: "new", lead: { business_name: "Reversed Co", source: "inbound", stage: "discovered" } });
  });

  it("refuses a header that is not exactly the list", () => {
    expect(() => previewLeadsCsv(`${HEADER.replace(",notes", "")}\nX`, NONE, NONE)).toThrow(/missing notes/);
    expect(() => previewLeadsCsv(`${HEADER},email\nX`, NONE, NONE)).toThrow(/not on the list: email/);
    expect(() => previewLeadsCsv(`${HEADER},notes\nX`, NONE, NONE)).toThrow(/repeated: notes/);
    expect(() => previewLeadsCsv("", NONE, NONE)).toThrow(LeadsCsvError);
    expect(() => previewLeadsCsv(HEADER, NONE, NONE)).toThrow(/no leads/);
    expect(() => previewLeadsCsv(`${HEADER}\n"unclosed`, NONE, NONE)).toThrow(/never closed/);
    expect(() => previewLeadsCsv(csv(...Array.from({ length: 501 }, (_, i) => line({ business_name: `L${i}`, source: "other" }))), NONE, NONE)).toThrow(/at most 500/);
  });

  it("says what is wrong with each row it cannot read", () => {
    const rows = previewLeadsCsv(
      csv(
        line({ source: "inbound" }),
        line({ business_name: "Bad url", source: "inbound", company_url: "javascript:alert(1)" }),
        line({ business_name: "Bad evidence", source: "inbound", evidence_url: "ftp://x.example/file", evidence_date: "2026-02-30" }),
        line({ business_name: "Bad enums", source: "cold_spam", contact_channel: "fax", evidence_confidence: "certain", segment: "bank" }),
        line({ business_name: "Bad flag", source: "inbound", size_uncertain: "maybe" }),
        line({ business_name: "Unknown campaign", source: "inbound", campaign_id: "nope" }),
        line({ business_name: "Bad campaign id", source: "inbound", campaign_id: "Not A Slug" }),
        `${line({ business_name: "Extra", source: "inbound" })},surplus`
      ),
      NONE,
      new Set(["agency-oct"])
    );
    const errors = (index: number) => (rows[index].status === "invalid" ? rows[index].errors.join(" | ") : "");
    expect(rows.every((row) => row.status === "invalid")).toBe(true);
    expect(errors(0)).toMatch(/business_name: required/);
    expect(errors(1)).toMatch(/company_url: an http\(s\) address/);
    expect(errors(2)).toMatch(/evidence_url: an http\(s\) address/);
    expect(errors(2)).toMatch(/evidence_date: a day as YYYY-MM-DD/);
    expect(errors(3)).toMatch(/source: one of/);
    expect(errors(3)).toMatch(/contact_channel: one of/);
    expect(errors(3)).toMatch(/evidence_confidence: one of/);
    expect(errors(3)).toMatch(/segment: one of/);
    expect(errors(4)).toMatch(/size_uncertain: true or false/);
    expect(errors(5)).toMatch(/no campaign nope/);
    expect(errors(6)).toMatch(/campaign_id: a campaign id/);
    expect(errors(7)).toMatch(/more values than columns/);
    expect(rows.map((row) => row.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("reports an existing lead or a repeated row as a duplicate, never as new", () => {
    const rows = previewLeadsCsv(
      csv(
        line({ business_name: "Known", company_url: "https://www.known.example", source: "inbound" }),
        line({ business_name: "Fresh", company_url: "https://fresh.example", source: "inbound" }),
        line({ business_name: "Fresh again", company_url: "https://FRESH.example/contact", source: "inbound" })
      ),
      new Set(["known.example"]),
      NONE
    );
    expect(rows.map((row) => row.status)).toEqual(["duplicate", "new", "duplicate"]);
    expect(rows[0]).toMatchObject({ dedupeKey: "known.example", why: expect.stringMatching(/left as it is/) });
    expect(rows[2]).toMatchObject({ dedupeKey: "fresh.example", why: "Repeats row 3 of this file." });
  });

  it("lands a row at verified only with both an evidence address and day, and reads the values", () => {
    const rows = previewLeadsCsv(
      csv(
        line({ business_name: " Both ", source: "Signal Outbound", evidence_url: "https://x.example/post", evidence_date: "2026-10-01", size_uncertain: "no", contact_channel: "LinkedIn", campaign_id: "agency-oct" }),
        line({ business_name: "Url only", source: "inbound", evidence_url: "https://y.example/post" }),
        line({ business_name: "Day only", source: "inbound", evidence_date: "2026-10-01" })
      ),
      NONE,
      new Set(["agency-oct"])
    );
    expect(rows.map((row) => (row.status === "new" ? row.lead.stage : row.status))).toEqual(["verified", "discovered", "discovered"]);
    expect(rows[0]).toMatchObject({
      lead: { business_name: "Both", source: "signal_outbound", size_uncertain: false, contact_channel: "linkedin", campaign_id: "agency-oct", sector: null, notes: null },
    });
    expect(rows[1]).toMatchObject({ lead: { size_uncertain: true } });
  });
});

describe("the export", () => {
  it("quotes what needs quoting and keeps a spreadsheet from running a formula", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a, "b"')).toBe('"a, ""b"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell(true)).toBe("true");
  });

  it("writes the import's columns, then where each lead stands, and reads back with the same parser", () => {
    const out = leadsToCsv([{ business_name: "Acme, Inc", source: "inbound", stage: "contacted", review_status: "approved_to_contact", created_at: "2026-10-01T00:00:00Z", size_uncertain: true }]);
    const rows = rowsFromCsv(out);
    expect(rows[0]).toEqual([...LEAD_CSV_HEADERS, "stage", "review_status", "created_at"]);
    expect(rows[1][0]).toBe("Acme, Inc");
    expect(rows[1].slice(-3)).toEqual(["contacted", "approved_to_contact", "2026-10-01T00:00:00Z"]);
  });
});
