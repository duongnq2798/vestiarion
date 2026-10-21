import { currentOrgId } from "./context";
import { db, unwrap } from "./dal";
import type { EvidenceKey } from "./evidence-export";
import { ledgerPublicKeyPems, ledgerVerificationKeyring, type LedgerRow } from "./ledger";
import { exportKeys } from "./ledger-export";
import { readPayeeLock } from "./payee-lock";
import { payeeLockEvidence, type CheckedEntry, type PayeeLockEvidence, type Period } from "./payee-lock-evidence";
import { listMembers } from "./platform/members";
import { verifyEntry } from "./receipts/verify";
import { workspaceNetwork } from "./workspace-network";

/**
 * Reads the payee lock's evidence pack for the workspace in scope (docs/superpowers/specs/2026-10-21-payee-lock-evidence-design.md
 * EP6): the address changes and lock changes in the period, then every later entry of the counterparties those changes
 * name, so a change late in the period still shows its confirmation and payment. Each entry is checked with the
 * workspace's keys. Read-only.
 */

const PAGE = 1000;

/** Every row a ledger query returns, a page at a time. */
async function allRows(build: (start: number, end: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<LedgerRow[]> {
  const rows: LedgerRow[] = [];
  for (let start = 0; ; start += PAGE) {
    const page = unwrap(await build(start, start + PAGE - 1)) as LedgerRow[];
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

function bounds(period: Period): { from: string | null; until: string | null } {
  return {
    from: period.from ? `${period.from}T00:00:00.000Z` : null,
    until: period.to ? new Date(Date.parse(`${period.to}T00:00:00Z`) + 86_400_000).toISOString() : null,
  };
}

export async function readPayeeLockEvidence(input: { workspace: { slug: string; name: string }; period: Period; now?: Date }): Promise<PayeeLockEvidence> {
  const orgDb = db();
  const { from, until } = bounds(input.period);
  const inPeriodRows = await allRows((start, end) => {
    let query = orgDb.from("ledger_entries").select("*").in("action", ["counterparty_address_changed", "payee_lock_changed"]);
    if (from) query = query.gte("ts", from);
    if (until) query = query.lt("ts", until);
    return query.order("seq", { ascending: true }).range(start, end);
  });

  const changed = inPeriodRows.filter((row) => row.action === "counterparty_address_changed");
  const counterpartyIds = [...new Set(changed.map((row) => row.detail.counterpartyId).filter((id): id is string => typeof id === "string"))];
  const firstSeq = changed.length > 0 ? Math.min(...changed.map((row) => row.seq)) : null;
  const later =
    counterpartyIds.length > 0 && firstSeq !== null
      ? await allRows((start, end) =>
          orgDb
            .from("ledger_entries")
            .select("*")
            .in("detail->>counterpartyId", counterpartyIds)
            .gt("seq", firstSeq)
            .order("seq", { ascending: true })
            .range(start, end)
        )
      : [];

  const bySeq = new Map<number, LedgerRow>();
  for (const row of [...inPeriodRows, ...later]) bySeq.set(row.seq, row);

  const [names, members, lock] = await Promise.all([
    counterpartyIds.length > 0
      ? (unwrap(await orgDb.from("counterparties").select("id, name").in("id", counterpartyIds)) as Array<{ id: string; name: string }>)
      : Promise.resolve([]),
    listMembers(currentOrgId()),
    readPayeeLock(orgDb),
  ]);
  // Lookalike warnings name other counterparties too: their names are read once more when any is missing.
  const lookalikeIds = [...bySeq.values()].flatMap((row) =>
    row.action === "counterparty_address_confirmed" && Array.isArray(row.detail.lookalikeOf)
      ? (row.detail.lookalikeOf as unknown[]).filter((id): id is string => typeof id === "string")
      : []
  );
  const known = new Map(names.map((row) => [row.id, row.name]));
  const missing = [...new Set(lookalikeIds.filter((id) => !known.has(id)))];
  if (missing.length > 0) {
    for (const row of unwrap(await orgDb.from("counterparties").select("id, name").in("id", missing)) as Array<{ id: string; name: string }>) {
      known.set(row.id, row.name);
    }
  }

  const keyring = ledgerVerificationKeyring();
  const publicKeys = ledgerPublicKeyPems(keyring);
  const entries: CheckedEntry[] = await Promise.all(
    [...bySeq.values()].map(async (row) => {
      try {
        return { ...row, check: await verifyEntry({ ...row, signing_key_id: row.signing_key_id ?? null }, publicKeys) };
      } catch {
        return { ...row, check: { ok: null, reason: "The signature could not be checked here." } as const };
      }
    })
  );
  const keys: EvidenceKey[] = exportKeys(keyring);

  return payeeLockEvidence({
    workspace: input.workspace,
    network: workspaceNetwork().id,
    period: input.period,
    lock,
    entries,
    counterparties: known,
    members: new Map(members.map((member) => [member.userId, member.email])),
    keys,
    now: input.now ?? new Date(),
  });
}
