import { z } from "zod";
import { readActualsFacts } from "../actual-payments";
import { db, platformDb, unwrap, type OrgDb } from "../dal";
import { withOrg } from "../dal/scope";
import { ledgerPublicKeyPems } from "../ledger";
import { networkOf } from "../network";
import type { SignedLink } from "../receipts/verify";
import { readBaseline } from "../report-baseline";
import { reportShareTokenHash } from "../report-share-token";
import { buildSharedReport, type SharedDecision, type SharedReportView } from "../shared-report";
import { readReportFacts } from "../workspace-report-read";

/**
 * What a shared report's link reads (docs/superpowers/specs/2026-10-10-shared-report-design.md S5, S11, S14). No
 * session: the link is the credential. A malformed link is never looked up; a well-formed one is looked up by the
 * SHA-256 of its secret through the service role's `report_share_by_token` (0095), which answers null for a stopped
 * or unknown link, and is missing before 0095 runs, which reads as no share.
 *
 * A live link's report is then read inside that workspace's own scope, as the API reads after a key lookup: the
 * readers the private report uses, the supplier names it knows and its payables' memos and purchase order references
 * (to hide them from the agent's reasoning), the chain
 * fields of the decisions shown and the public halves of its signing keys. The workspace's id goes no further than
 * this file; the view names it only when the share shows its name.
 */

export interface SharedReportShown extends SharedReportView {
  /** Each decision with its entry's signed link, which the reader's browser checks; never the entry's body. */
  decisions: Array<SharedDecision & { link: SignedLink | null }>;
  /** The public halves of the workspace's signing keys, by id, as PEM. */
  publicKeys: Record<string, string>;
}

const foundSchema = z.object({
  shareId: z.string().uuid(),
  orgId: z.string().uuid(),
  createdAt: z.string(),
  showNames: z.boolean(),
  showAmounts: z.boolean(),
  showWorkspaceName: z.boolean(),
  name: z.string().nullable(),
  mode: z.string(),
  network: z.string().nullable(),
});

/** PostgREST's "no such function" (PGRST202) or Postgres's (42883): migration 0095 has not run here yet. */
const missingFunction = (error: { code?: string }) => error.code === "PGRST202" || error.code === "42883";

const PAGE = 1000;

/** Every supplier name the workspace knows, a page at a time. */
async function counterpartyNames(orgDb: OrgDb): Promise<string[]> {
  const names: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(await orgDb.from("counterparties").select("name").order("id", { ascending: true }).range(from, from + PAGE - 1)) as Array<{ name: string | null }>;
    names.push(...page.flatMap((row) => (row.name ? [row.name] : [])));
    if (page.length < PAGE) return names;
  }
}

/** Every payable's memo and purchase order reference, a page at a time: the agent's reasoning may quote them. */
async function billTexts(orgDb: OrgDb): Promise<Array<{ memo: string | null; poReference: string | null }>> {
  const texts: Array<{ memo: string | null; poReference: string | null }> = [];
  for (let from = 0; ; from += PAGE) {
    const page = unwrap(
      await orgDb.from("invoices").select("memo, po_reference").eq("direction", "payable").order("id", { ascending: true }).range(from, from + PAGE - 1)
    ) as Array<{ memo: string | null; po_reference: string | null }>;
    texts.push(...page.flatMap((row) => (row.memo || row.po_reference ? [{ memo: row.memo ?? null, poReference: row.po_reference ?? null }] : [])));
    if (page.length < PAGE) return texts;
  }
}

/** The signed links of these entries: their hashes, signature and key, never their bodies. */
async function signedLinks(orgDb: OrgDb, seqs: number[]): Promise<Map<number, SignedLink>> {
  if (seqs.length === 0) return new Map();
  const rows = unwrap(await orgDb.from("ledger_entries").select("seq, body_hash, signature, prev_hash, hash, signing_key_id").in("seq", seqs)) as Array<
    SignedLink & { seq: number | string }
  >;
  return new Map(
    rows.map((row) => [
      Number(row.seq),
      { body_hash: row.body_hash, signature: row.signature, prev_hash: row.prev_hash, hash: row.hash, signing_key_id: row.signing_key_id ?? null },
    ])
  );
}

export async function readSharedReport(token: string, now: Date = new Date()): Promise<SharedReportShown | null> {
  const tokenHash = reportShareTokenHash(token);
  if (!tokenHash) return null;
  const answer = await platformDb().rpc("report_share_by_token", { p_token_hash: tokenHash });
  if (answer.error) {
    if (missingFunction(answer.error)) return null;
    throw new Error(answer.error.message);
  }
  if (answer.data === null || answer.data === undefined) return null;
  const found = foundSchema.parse(answer.data);
  const network = networkOf(found.network);

  return withOrg(found.orgId, async () => {
    const [facts, actuals, baseline, knownNames, texts] = await Promise.all([
      readReportFacts(db(), network, { sandbox: found.mode === "sandbox" }, now),
      readActualsFacts(db()),
      readBaseline(db()),
      counterpartyNames(db()),
      billTexts(db()),
    ]);
    const view = buildSharedReport({
      facts,
      actuals,
      baseline,
      options: { names: found.showNames ? "shown" : "labels", amounts: found.showAmounts ? "shown" : "hidden", title: found.showWorkspaceName ? "workspace" : "neutral" },
      name: found.showWorkspaceName ? found.name : null,
      sharedAt: found.createdAt,
      knownNames,
      billTexts: texts,
      now: now.toISOString(),
    });
    const links = await signedLinks(db(), view.decisions.map((decision) => decision.seq));
    return { ...view, decisions: view.decisions.map((decision) => ({ ...decision, link: links.get(decision.seq) ?? null })), publicKeys: ledgerPublicKeyPems() };
  });
}
