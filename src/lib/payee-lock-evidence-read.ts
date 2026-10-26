import { currentOrgId } from "./context";
import { db, unwrap, type OrgDb } from "./dal";
import type { EvidenceKey } from "./evidence-export";
import { ledgerPublicKeyPems, ledgerVerificationKeyring, type LedgerRow } from "./ledger";
import { exportKeys } from "./ledger-export";
import { readPayeeLock } from "./payee-lock";
import { payeeLockEvidence, type PayeeLockEvidence, type Period } from "./payee-lock-evidence";
import { listMembers } from "./platform/members";
import { verifyEntry } from "./receipts/verify";
import { workspaceNetwork } from "./workspace-network";

/**
 * Reads the payee lock's evidence pack for the workspace in scope (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md
 * EP6): the address changes and lock changes in the period, then every entry of the counterparties those changes name,
 * so a change late in the period still shows its confirmation and payment, and a transfer sent to an earlier address is
 * told apart. Only the entries the pack cites are checked with the workspace's keys. Read-only.
 */

const PAGE = 1000;
/** Ids per `in` filter, to keep each request's address short, as the new payee facts do. */
const ID_CHUNK = 100;

/** Every row a ledger query returns, a page at a time. */
async function allRows(build: (start: number, end: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = unwrap(await build(start, start + PAGE - 1)) as LedgerRow[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const chunks = <T>(values: readonly T[]): T[][] =>
  Array.from({ length: Math.ceil(values.length / ID_CHUNK) }, (_, index) => values.slice(index * ID_CHUNK, (index + 1) * ID_CHUNK));

function bounds(period: Period): { from: string | null; until: string | null } {
  return {
    from: period.from ? `${period.from}T00:00:00.000Z` : null,
    until: period.to ? new Date(Date.parse(`${period.to}T00:00:00Z`) + 86_400_000).toISOString() : null,
  };
}

async function namesOf(orgDb: OrgDb, ids: readonly string[]): Promise<Array<{ id: string; name: string }>> {
  const rows: Array<{ id: string; name: string }> = [];
  for (const chunk of chunks(ids)) {
    rows.push(...(unwrap(await orgDb.from("counterparties").select("id, name").in("id", chunk)) as Array<{ id: string; name: string }>));
  }
  return rows;
}

/** `people`: "email" for a member's page and download, "id" for the API, which names no one by email (evidence API EA3). */
export async function readPayeeLockEvidence(input: {
  workspace: { slug: string; name: string };
  period: Period;
  now?: Date;
  people?: "email" | "id";
}): Promise<PayeeLockEvidence> {
  const orgDb = db();
  const { from, until } = bounds(input.period);
  const inPeriodRows = await allRows((start, end) => {
    let query = orgDb.from("ledger_entries").select("*").in("action", ["counterparty_address_changed", "payee_lock_changed"]);
    if (from) query = query.gte("ts", from);
    if (until) query = query.lt("ts", until);
    return query.order("seq", { ascending: true }).range(start, end);
  });

  const counterpartyIds = [
    ...new Set(
      inPeriodRows
        .filter((row) => row.action === "counterparty_address_changed")
        .map((row) => row.detail.counterpartyId)
        .filter((id): id is string => typeof id === "string")
    ),
  ];
  const bySeq = new Map<number, LedgerRow>();
  for (const row of inPeriodRows) bySeq.set(row.seq, row);
  for (const chunk of chunks(counterpartyIds)) {
    const rows = await allRows((start, end) =>
      orgDb.from("ledger_entries").select("*").in("detail->>counterpartyId", chunk).order("seq", { ascending: true }).range(start, end)
    );
    for (const row of rows) bySeq.set(row.seq, row);
  }

  // Lookalike warnings name other counterparties too.
  const lookalikeIds = [...bySeq.values()].flatMap((row) =>
    row.action === "counterparty_address_confirmed" && Array.isArray(row.detail.lookalikeOf)
      ? (row.detail.lookalikeOf as unknown[]).filter((id): id is string => typeof id === "string")
      : []
  );
  const [names, members, lock] = await Promise.all([
    namesOf(orgDb, [...new Set([...counterpartyIds, ...lookalikeIds])]),
    listMembers(currentOrgId()),
    readPayeeLock(orgDb),
  ]);

  const keyring = ledgerVerificationKeyring();
  const keys: EvidenceKey[] = exportKeys(keyring);
  const doc = payeeLockEvidence({
    workspace: input.workspace,
    network: workspaceNetwork().id,
    period: input.period,
    lock,
    entries: [...bySeq.values()],
    counterparties: new Map(names.map((row) => [row.id, row.name])),
    members: new Map(members.map((member) => [member.userId, member.email])),
    keys,
    now: input.now ?? new Date(),
    people: input.people ?? "email",
  });

  // Each entry the pack cites, checked alone with the workspace's keys (EP5).
  const publicKeys = ledgerPublicKeyPems(keyring);
  await Promise.all(
    doc.entries.map(async (entry) => {
      try {
        entry.check = await verifyEntry({ ...entry, signing_key_id: entry.signing_key_id ?? null }, publicKeys);
      } catch {
        entry.check = { ok: null, reason: "The signature could not be checked here." };
      }
    })
  );
  return doc;
}
