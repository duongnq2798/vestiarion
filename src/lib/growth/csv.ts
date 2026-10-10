import { z } from "zod";
import { rowsFromCsv } from "../invoice-csv";
import { CAMPAIGN_ID, CONFIDENCES, CONTACT_CHANNELS, SEGMENTS, SOURCES, type Stage } from "./fields";

/**
 * Leads to and from a CSV, for the founder dashboard. Pure: the preview and the save both read the file through
 * `previewLeadsCsv`, so what is saved is what the preview showed, read again against the leads that exist by then.
 *
 * The header is exactly `LEAD_CSV_HEADERS`, in any order: a column missing or one not on the list refuses the file.
 * Every row is checked with zod (http(s) addresses only, days as YYYY-MM-DD, the database's enums). A lead is the same
 * as another when their dedupe keys match (`dedupeKey`): an existing one is reported as a duplicate and never
 * overwritten, and so is a row repeating an earlier row of the same file. A row always lands needing review, at
 * `verified` when it has both an evidence address and an evidence day, else at `discovered`.
 */

export const LEAD_CSV_HEADERS = [
  "business_name",
  "company_url",
  "sector",
  "geography",
  "size_estimate",
  "size_uncertain",
  "prospect_role",
  "contact_channel",
  "contact_handle",
  "signal",
  "evidence_url",
  "evidence_date",
  "inferred_pain",
  "evidence_confidence",
  "existing_solution",
  "outreach_angle",
  "draft_message",
  "campaign_id",
  "segment",
  "source",
  "source_detail",
  "notes",
] as const;
export type LeadCsvHeader = (typeof LEAD_CSV_HEADERS)[number];

/** The export adds where each lead stands. */
export const LEAD_EXPORT_HEADERS = [...LEAD_CSV_HEADERS, "stage", "review_status", "created_at"] as const;

export const LEADS_CSV_MAX_ROWS = 500;
export const LEADS_CSV_MAX_BYTES = 1_000_000;

/** A file that cannot be read as a leads CSV at all, in words for the person who chose it. */
export class LeadsCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadsCsvError";
  }
}

const blank = (value: string) => value.trim() === "";
/** A free-text column: trimmed, empty as null, at most `max` characters. */
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(max, `at most ${max} characters`))
    .transform((value) => (value === "" ? null : value));

const httpUrl = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".") && value.length <= 500;
    } catch {
      return false;
    }
  }, "an http(s) address")
  .transform((value) => (value === "" ? null : value));

const day = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => {
    if (value === "") return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const at = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
  }, "a day as YYYY-MM-DD")
  .transform((value) => (value === "" ? null : value));

/** An optional enum column: blank as null, anything else one of `values` (case and spaces forgiven). */
const choice = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((value) => value.trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .refine((value) => value === "" || (values as readonly string[]).includes(value), `one of ${values.join(", ")}`)
    .transform((value) => (value === "" ? null : (value as T[number])));

const flag = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ["", "true", "false", "yes", "no", "1", "0"].includes(value), "true or false")
  // Blank means the size is uncertain, as the column's default says.
  .transform((value) => value === "" || ["true", "yes", "1"].includes(value));

const rowSchema = z.object({
  business_name: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(1, "required").max(200, "at most 200 characters")),
  company_url: httpUrl,
  sector: text(200),
  geography: text(200),
  size_estimate: text(100),
  size_uncertain: flag,
  prospect_role: text(200),
  contact_channel: choice(CONTACT_CHANNELS),
  contact_handle: text(200),
  signal: text(2000),
  evidence_url: httpUrl,
  evidence_date: day,
  inferred_pain: text(2000),
  evidence_confidence: choice(CONFIDENCES),
  existing_solution: text(1000),
  outreach_angle: text(2000),
  draft_message: text(5000),
  campaign_id: z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .refine((value) => value === "" || CAMPAIGN_ID.test(value), "a campaign id: 2 to 40 of a-z, 0-9 and -")
    .transform((value) => (value === "" ? null : value)),
  segment: choice(SEGMENTS),
  source: choice(SOURCES).refine((value) => value !== null, "required"),
  source_detail: text(500),
  notes: text(5000),
});

export type LeadCsvValues = z.infer<typeof rowSchema>;

/** A lead as it is added: the row's values with its dedupe key and the stage it starts at. */
export type NewLead = LeadCsvValues & { source: NonNullable<LeadCsvValues["source"]>; dedupe_key: string; stage: Extract<Stage, "discovered" | "verified"> };

export type LeadPreviewRow =
  | { line: number; status: "new"; lead: NewLead }
  | { line: number; status: "duplicate"; businessName: string; dedupeKey: string; why: string }
  | { line: number; status: "invalid"; businessName: string; errors: string[] };

/**
 * Two leads are the same business when their keys match: the lower-case host of the company's address without a
 * leading `www.`, or, with no address, the lower-case business name with its spaces trimmed and collapsed.
 */
export function dedupeKey(businessName: string, companyUrl: string | null | undefined): string {
  if (companyUrl) {
    try {
      const host = new URL(companyUrl.trim()).hostname.toLowerCase().replace(/^www\./, "");
      if (host) return host;
    } catch {
      // Not an address: the name decides.
    }
  }
  return businessName.trim().toLowerCase().replace(/\s+/g, " ");
}

function readRows(csv: string): { headers: string[]; rows: string[][] } {
  let rows: string[][];
  try {
    rows = rowsFromCsv(csv.replace(/^﻿/, ""));
  } catch {
    throw new LeadsCsvError("The CSV has a quoted field that is never closed.");
  }
  if (rows.length === 0) throw new LeadsCsvError("The CSV is empty.");
  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const missing = LEAD_CSV_HEADERS.filter((header) => !headers.includes(header));
  const unknown = headers.filter((header) => !(LEAD_CSV_HEADERS as readonly string[]).includes(header));
  const repeated = headers.filter((header, index) => headers.indexOf(header) !== index);
  if (missing.length || unknown.length || repeated.length) {
    const parts = [
      missing.length ? `missing ${missing.join(", ")}` : "",
      unknown.length ? `not on the list: ${unknown.join(", ")}` : "",
      repeated.length ? `repeated: ${[...new Set(repeated)].join(", ")}` : "",
    ].filter(Boolean);
    throw new LeadsCsvError(`The header must be exactly ${LEAD_CSV_HEADERS.join(",")} (${parts.join("; ")}).`);
  }
  if (rows.length < 2) throw new LeadsCsvError("The CSV has a header and no leads.");
  if (rows.length - 1 > LEADS_CSV_MAX_ROWS) throw new LeadsCsvError(`A CSV holds at most ${LEADS_CSV_MAX_ROWS} leads.`);
  return { headers, rows: rows.slice(1) };
}

/**
 * Each row of the file as it would be saved, or why it would not be: checked, then matched against the dedupe keys
 * that exist (`existingKeys`) and the campaigns there are (`campaignIds`).
 */
export function previewLeadsCsv(csv: string, existingKeys: ReadonlySet<string>, campaignIds: ReadonlySet<string>): LeadPreviewRow[] {
  const { headers, rows } = readRows(csv);
  const seen = new Map<string, number>();
  return rows.map((values, index): LeadPreviewRow => {
    const line = index + 2;
    const record = Object.fromEntries(LEAD_CSV_HEADERS.map((header) => [header, values[headers.indexOf(header)] ?? ""]));
    const businessName = (record.business_name ?? "").trim() || "(no name)";
    if (values.length > headers.length && values.slice(headers.length).some((value) => !blank(value))) {
      return { line, status: "invalid", businessName, errors: ["more values than columns"] };
    }
    const parsed = rowSchema.safeParse(record);
    if (!parsed.success) {
      return { line, status: "invalid", businessName, errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) };
    }
    const row = parsed.data;
    if (row.campaign_id && !campaignIds.has(row.campaign_id)) {
      return { line, status: "invalid", businessName, errors: [`campaign_id: no campaign ${row.campaign_id}`] };
    }
    const key = dedupeKey(row.business_name, row.company_url);
    if (existingKeys.has(key)) return { line, status: "duplicate", businessName, dedupeKey: key, why: "A lead with this key exists; it is left as it is." };
    const earlier = seen.get(key);
    if (earlier !== undefined) return { line, status: "duplicate", businessName, dedupeKey: key, why: `Repeats row ${earlier} of this file.` };
    seen.set(key, line);
    const stage = row.evidence_url && row.evidence_date ? "verified" : "discovered";
    return { line, status: "new", lead: { ...row, source: row.source as NewLead["source"], dedupe_key: key, stage } };
  });
}

/**
 * One cell: quoted when it holds a comma, a quote or a line break, and with a leading apostrophe when a spreadsheet
 * would run it as a formula (it starts with =, +, -, @, a tab or a carriage return).
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let cell = typeof value === "string" ? value : String(value);
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** Every lead as a CSV with `LEAD_EXPORT_HEADERS`, the import's columns first. */
export function leadsToCsv(leads: Array<Partial<Record<(typeof LEAD_EXPORT_HEADERS)[number], unknown>>>): string {
  const lines = [LEAD_EXPORT_HEADERS.join(",")];
  for (const lead of leads) lines.push(LEAD_EXPORT_HEADERS.map((header) => csvCell(lead[header])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** The header and one example row, for the import's description. */
export const LEADS_CSV_TEMPLATE = `${LEAD_CSV_HEADERS.join(",")}\nNorthwind Studio,https://northwind.example,software,Vietnam,10-20,true,Founder,linkedin,,Hiring a finance ops lead,https://northwind.example/jobs/finance,2026-10-01,Paying contractors by hand,medium,Spreadsheets,,,,software_agency,signal_outbound,,`;
