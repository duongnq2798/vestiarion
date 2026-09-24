export interface TreasuryPayload {
  accounts: Array<{
    id: string;
    name: string;
    kind: "operating" | "reserve" | "chain";
    chain: string;
    token: string;
    address: string | null;
    balance: number;
    apy: number;
  }>;
  reservePosition: number;
  obligations: {
    asOf: string | null;
    dueWithin7Days: number | null;
    dueWithin14Days: number | null;
  };
  latestForecast: {
    id: string;
    asOf: string;
    horizonDays: number;
    projectedInflow: number;
    projectedOutflow: number;
    liquidBalance: number;
    recommendation: string | null;
  } | null;
  recentActions: Array<{
    id: string;
    action: "sweep_to_usyc" | "redeem_from_usyc" | "rebalance";
    amount: number;
    fromAccountId: string | null;
    toAccountId: string | null;
    reasoning: string | null;
    createdAt: string;
  }>;
}

const nullableString = (value: unknown): string | null =>
  value == null ? null : String(value);

export function mapTreasuryPayload(
  accountRows: Array<Record<string, unknown>>,
  snapshotRow: Record<string, unknown> | null,
  forecastRow: Record<string, unknown> | null,
  actionRows: Array<Record<string, unknown>>
): TreasuryPayload {
  const accounts = accountRows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as TreasuryPayload["accounts"][number]["kind"],
    chain: String(row.chain),
    token: String(row.token),
    address: nullableString(row.address),
    balance: Number(row.balance),
    apy: Number(row.apy),
  }));

  return {
    accounts,
    reservePosition: accounts
      .filter((account) => account.kind === "reserve")
      .reduce((total, account) => total + account.balance, 0),
    obligations: {
      asOf: snapshotRow ? String(snapshotRow.captured_at) : null,
      dueWithin7Days: snapshotRow ? Number(snapshotRow.obligations_due_7d) : null,
      dueWithin14Days: snapshotRow ? Number(snapshotRow.obligations_due_14d) : null,
    },
    latestForecast: forecastRow
      ? {
          id: String(forecastRow.id),
          asOf: String(forecastRow.as_of),
          horizonDays: Number(forecastRow.horizon_days),
          projectedInflow: Number(forecastRow.projected_inflow),
          projectedOutflow: Number(forecastRow.projected_outflow),
          liquidBalance: Number(forecastRow.liquid_balance),
          recommendation: nullableString(forecastRow.recommendation),
        }
      : null,
    recentActions: actionRows.map((row) => ({
      id: String(row.id),
      action: row.action as TreasuryPayload["recentActions"][number]["action"],
      amount: Number(row.amount),
      fromAccountId: nullableString(row.from_account),
      toAccountId: nullableString(row.to_account),
      reasoning: nullableString(row.reasoning),
      createdAt: String(row.created_at),
    })),
  };
}
