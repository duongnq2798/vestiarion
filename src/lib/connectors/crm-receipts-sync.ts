import { connectionById } from "./connections";
import type { CrmProvider } from "./crm";
import { queueReceipts, sendReceipts, type SendSummary } from "./crm-receipts-run";
import { receiptStore, writesSwitch } from "./crm-receipts-store";
import { PROVIDER_LABELS } from "./provider";
import { connectionTokenStore } from "./token-store";
import { freshAccessToken } from "./tokens";

/**
 * The receipts' part of each CRM sync (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R5, R6), in the
 * workspace already in scope: queue a write for each planned deal whose figures changed, then send the writes due. Only
 * while a person has writing turned on for the connection; nothing before migration 0107 has run. The access token is
 * asked for only when a write is due, once.
 */

export interface ReceiptRunSummary extends SendSummary {
  queued: number;
}

export async function receiptsInScope(connectionId: string, provider: CrmProvider, now: () => number = Date.now): Promise<ReceiptRunSummary | null> {
  if (!provider.receipts) return null;
  const connection = await connectionById(connectionId);
  if (!connection || connection.status !== "connected") return null;
  const writes = await writesSwitch(connection.id);
  if (!writes?.on) return null;
  let token: Promise<string | null> | null = null;
  const accessToken = () => {
    token ??= freshAccessToken({ store: connectionTokenStore(connection.orgId, connection.id), refresh: provider.refresh, now }).then((outcome) => (outcome.ok ? outcome.accessToken : null));
    return token;
  };
  const deps = { connection, writer: provider.receipts, label: PROVIDER_LABELS[connection.provider], store: receiptStore, accessToken, now };
  const { queued } = await queueReceipts(deps);
  const sent = await sendReceipts({ ...deps, writesOn: writes.on });
  return { queued, ...sent };
}
