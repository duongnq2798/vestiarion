import { NextResponse } from "next/server";
import { currentOrgId } from "../context";
import { platformDb } from "../dal";
import { evidenceDocument, type EvidenceDocument } from "../evidence-export";
import { readEvidence } from "../evidence-read";
import { ledgerVerificationKeyring } from "../ledger";
import { exportKeys } from "../ledger-export";
import { apiError } from "./guard";

/**
 * What the five evidence reads share (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-design.md):
 * the brake's answer (EA6), the key's workspace by its own row, one payment's evidence with members named by user id
 * (EA3), and the answer itself, serialized once, never cached, and refused over 4 MB for a period's documents (EA7).
 * Each reads in the key's workspace (`handleApiRequest` runs it in `withOrg`), and none writes anything (EA8).
 */

/** Under Vercel's 4.5 MB response limit, with room for the headers. */
export const API_DOCUMENT_MAX_BYTES = 4_000_000;
export const EVIDENCE_READS_LIMITED = "Too many evidence reads from this key. Try again in a minute.";
export const MONTH_REFUSED = "month must be YYYY-MM, and not a month still to come";
export const PERIOD_REFUSED = "from and to must be days as YYYY-MM-DD, from no later than to";
export const CLOSE_PACK_TOO_LARGE =
  "This month's close pack is over 4 MB, more than one answer carries. Download it from the workspace's Monthly close pack page.";
export const PAYEE_LOCK_TOO_LARGE = "This period's evidence is over 4 MB, more than one answer carries. Ask for a shorter period with from and to.";

/** 429 rate_limited with Retry-After: 60, when the bucket is full again (EA6). */
export function evidenceReadsLimited(): NextResponse {
  return apiError("rate_limited", EVIDENCE_READS_LIMITED, { "Retry-After": "60" });
}

/** The 404 a payable's evidence and receipt answer for anything but a payable of the workspace (EA5). */
export function payableNotFound(id: string): NextResponse {
  return apiError("not_found", `Payable invoice "${id}" was not found.`);
}

/** The 404 a milestone's evidence answers for an id the workspace does not hold (EA5). */
export function milestoneNotFound(id: string): NextResponse {
  return apiError("not_found", `Milestone "${id}" was not found.`);
}

/** The key's workspace, `{ slug, name }`, from its own row by the scope's org id: a key holds no membership. */
export async function workspaceInScope(): Promise<{ slug: string; name: string }> {
  const read = await platformDb().from("orgs").select("slug, name").eq("id", currentOrgId()).maybeSingle();
  if (read.error) throw new Error(read.error.message);
  const row = read.data as { slug?: unknown; name?: unknown } | null;
  if (!row || typeof row.slug !== "string" || typeof row.name !== "string") throw new Error("the workspace in scope was not found");
  return { slug: row.slug, name: row.name };
}

/**
 * `{ data: document }` as JSON, with `cache-control: no-store`, serialized once. With `tooLarge`, an answer over
 * API_DOCUMENT_MAX_BYTES in UTF-8 is refused with 400 invalid_request and that message instead (EA7).
 */
export function documentAnswer(document: object, options: { tooLarge?: string } = {}): NextResponse {
  const body = JSON.stringify({ data: document });
  if (options.tooLarge && new TextEncoder().encode(body).length > API_DOCUMENT_MAX_BYTES) return apiError("invalid_request", options.tooLarge);
  return new NextResponse(body, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/**
 * One payable's or milestone's evidence, the file its page's Download evidence gives, with members named by user id
 * (EA3); null when the workspace holds no such payable or milestone: a receivable, an unknown id, another workspace's.
 */
export async function readPaymentEvidence(kind: "invoice" | "milestone", id: string): Promise<EvidenceDocument | null> {
  const read = await readEvidence(kind, id, { people: "id" });
  if (!read) return null;
  return evidenceDocument({ chain: read.chain, workspace: await workspaceInScope(), keys: exportKeys(ledgerVerificationKeyring()), now: new Date() });
}
