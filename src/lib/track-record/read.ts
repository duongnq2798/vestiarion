import { currentOrgId } from "../context";
import { db, unwrap, type OrgDb } from "../dal";
import { readEarnedView } from "../earned-vendors-store";
import { ledgerPublicKeyPems, ledgerVerificationKeyring, type LedgerRow } from "../ledger";
import { exportKeys } from "../ledger-export";
import { listMembers } from "../platform/members";
import { verifyEntry, type EntryCheck } from "../receipts/verify";
import { workspaceNetwork } from "../workspace-network";
import { allRows, readReportFacts } from "../workspace-report-read";
import { buildTrackRecord, TRACK_RECORD_CONFIRMED, type TrackRecord } from "./build";

/**
 * Reads the agent's track record for the workspace in scope (docs/superpowers/specs/2026-11-07-track-record-design.md
 * TR1, TR2): the report's facts, the earned vendors best effort, the entries it cites a hundred seqs per read, the
 * ledger's head, and, for the page, the members' emails. Then it builds twice, as the close pack does (CP10): once to
 * find the entries it cites, then with each of those checked alone against the workspace's keys.
 */

const CHUNK = 100;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += CHUNK) out.push(items.slice(start, start + CHUNK));
  return out;
}

function entries(orgDb: OrgDb, filter: (query: ReturnType<ReturnType<OrgDb["from"]>["select"]>) => ReturnType<ReturnType<OrgDb["from"]>["select"]>) {
  return allRows<LedgerRow>((start, end) => filter(orgDb.from("ledger_entries").select("*")).order("seq", { ascending: true }).range(start, end));
}

export async function readTrackRecord(input: {
  workspace: { slug: string; name: string };
  /** Simulated payments only: the workspace is a sandbox (capability and reasons R5). */
  sandbox: boolean;
  /** Members by email, for the page; by user id in the file. */
  people: "email" | "id";
  now?: Date;
}): Promise<TrackRecord> {
  const orgDb = db();
  const network = workspaceNetwork().id;
  const now = input.now ?? new Date();
  const facts = await readReportFacts(orgDb, network, { sandbox: input.sandbox }, now);
  const decisionSeqs = [...new Set(facts.verdicts.map((verdict) => verdict.entrySeq))];

  const [earned, decisions, others, head, members] = await Promise.all([
    // Best effort, as the report reads it: a failure or a database before migration 0146 leaves earned vendors out.
    readEarnedView(orgDb, facts).catch((error: unknown) => {
      console.error("track record: earned vendors not read", error instanceof Error ? error.message : error);
      return null;
    }),
    Promise.all(chunks(decisionSeqs).map((seqs) => entries(orgDb, (query) => query.in("seq", seqs)))).then((groups) => groups.flat()),
    entries(orgDb, (query) => query.in("action", ["decision_verdict", "vendor_earned", "vendor_earned_lost", TRACK_RECORD_CONFIRMED])),
    orgDb.from("ledger_entries").select("seq, hash").order("seq", { ascending: false }).limit(1),
    input.people === "email"
      ? listMembers(currentOrgId()).catch((error: unknown) => {
          console.error("track record: members not read", error instanceof Error ? error.message : error);
          return [];
        })
      : Promise.resolve([]),
  ]);

  const ledger = [...new Map([...decisions, ...others].map((row) => [row.seq, row])).values()].sort((a, b) => a.seq - b.seq);
  const headRow = (unwrap(head) as Array<{ seq: number; hash: string }>)[0] ?? null;
  const keyring = ledgerVerificationKeyring();
  const base = {
    workspace: input.workspace,
    network,
    readAt: now.toISOString(),
    facts,
    earned,
    ledger,
    keys: exportKeys(keyring),
    ledgerHead: headRow ? { seq: headRow.seq, hash: headRow.hash } : null,
    emails: new Map(members.map((member) => [member.userId, member.email])),
  };

  // Built once to find the entries it cites, then again with each of those checked alone (TR2).
  const first = buildTrackRecord(base);
  const publicKeys = ledgerPublicKeyPems(keyring);
  const checked = await Promise.all(
    first.entries.map(async (entry): Promise<[number, EntryCheck]> => {
      try {
        return [entry.seq, await verifyEntry({ ...entry, signing_key_id: entry.signing_key_id ?? null }, publicKeys)];
      } catch {
        return [entry.seq, { ok: null, reason: "The signature could not be checked here." }];
      }
    })
  );
  return buildTrackRecord({ ...base, checks: new Map(checked) });
}
