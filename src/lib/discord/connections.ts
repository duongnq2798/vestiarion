import { currentOrgId } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { decryptSecret, encryptSecret, masterKeysFromEnv, type MasterKey, type SecretEnvelope } from "../secrets";
import type { DiscordWebhookInfo } from "./api";
import type { DiscordWebhookUrl } from "./webhook-url";

/**
 * A workspace's Discord channel webhook (docs/superpowers/specs/2026-10-22-discord-design.md DC1, DC2, DC5), in a
 * platform row the service role alone reads and writes (migration 0140). The webhook's URL is kept only as an envelope
 * under the master key, bound to the workspace and its column, and is never returned to the browser, logged or put in
 * the ledger. Connecting and disconnecting are recorded in the workspace's own ledger, with Discord's ids only; those
 * functions run inside that workspace's scope.
 *
 * Before migration 0140 runs, the table is not there: a read says so (`ready: false`), and nothing fails.
 */

export interface DiscordConnection {
  id: string;
  orgId: string;
  webhookId: string;
  channelId: string;
  guildId: string | null;
  /** The webhook's name in Discord. */
  name: string;
  connectedBy: string | null;
  connectedAt: string;
  /** The last ledger entry the channel was told about. */
  notifiedSeq: number;
  /** What the last post Discord did not take said, and when; null once a post went. */
  lastError: string | null;
  lastErrorAt: string | null;
  /** Posts Discord did not take since the last one it did. */
  failures: number;
  webhookUrlEnc: SecretEnvelope;
}

interface ConnectionRow {
  id: string;
  org_id: string;
  webhook_id: string;
  channel_id: string;
  guild_id: string | null;
  name: string;
  connected_by: string | null;
  connected_at: string;
  notified_seq: number | string;
  last_error: string | null;
  last_error_at: string | null;
  failures: number | string;
  webhook_url_enc: SecretEnvelope;
}

const COLUMNS =
  "id, org_id, webhook_id, channel_id, guild_id, name, connected_by, connected_at, notified_seq, last_error, last_error_at, failures, webhook_url_enc";
const WEBHOOK_COLUMN = "discord_webhooks.webhook_url_enc";
/** The most of an error a row keeps (0140's check). */
export const LAST_ERROR_MAX = 300;

const toConnection = (row: ConnectionRow): DiscordConnection => ({
  id: row.id,
  orgId: row.org_id,
  webhookId: row.webhook_id,
  channelId: row.channel_id,
  guildId: row.guild_id ?? null,
  name: row.name,
  connectedBy: row.connected_by,
  connectedAt: row.connected_at,
  notifiedSeq: Number(row.notified_seq),
  lastError: row.last_error ?? null,
  lastErrorAt: row.last_error_at ?? null,
  failures: Number(row.failures ?? 0),
  webhookUrlEnc: row.webhook_url_enc,
});

type PostgrestError = { code?: string; message?: string } | null;
/** Before migration 0140 runs, its table is not there: Discord is not available yet, and nothing fails. */
export const discordNotReady = (error: PostgrestError) =>
  ["PGRST205", "42P01"].includes(error?.code ?? "") || (/discord_webhooks/.test(error?.message ?? "") && /schema cache|does not exist/.test(error?.message ?? ""));

export type ConnectionRead = { ready: false } | { ready: true; connection: DiscordConnection | null };

/** The workspace's connection, or none; `ready: false` before migration 0140. Any other failure throws. */
export async function readConnection(orgId: string): Promise<ConnectionRead> {
  const result = await platformDb().from("discord_webhooks").select(COLUMNS).eq("org_id", orgId).limit(1);
  if (result.error) {
    if (discordNotReady(result.error)) return { ready: false };
    throw new Error(result.error.message);
  }
  const rows = (result.data ?? []) as unknown as ConnectionRow[];
  return { ready: true, connection: rows[0] ? toConnection(rows[0]) : null };
}

export function webhookUrlOf(connection: DiscordConnection, keys: MasterKey[] = masterKeysFromEnv()): string {
  return decryptSecret(connection.webhookUrlEnc, { orgId: connection.orgId, column: WEBHOOK_COLUMN }, keys);
}

/** Entries about a connection belong to its own workspace's ledger, and nowhere else. */
function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("A Discord connection's entry cannot be written to another workspace's ledger");
}

async function ledgerHead(): Promise<number> {
  const rows = unwrap(await db().from("ledger_entries").select("seq").order("seq", { ascending: false }).limit(1)) as Array<{ seq: number | string }>;
  return Number(rows[0]?.seq ?? 0);
}

/** Another channel was saved for the workspace between the check and the save: two people connected at once. */
export class DiscordAlreadyConnectedError extends Error {
  constructor() {
    super("The workspace already has a Discord connection");
    this.name = "DiscordAlreadyConnectedError";
  }
}

/**
 * Saves a webhook Discord took a test message on (DC1): the canonical URL as an envelope, what Discord said of its
 * channel, and the cursor at the ledger's head, so the channel is never sent the past. A workspace has one connection:
 * a second insert fails on 0140's unique key, nothing is replaced, and `DiscordAlreadyConnectedError` says so.
 */
export async function saveConnection(
  input: { orgId: string; connectedBy: string; webhook: DiscordWebhookUrl; info: DiscordWebhookInfo },
  keys: MasterKey[] = masterKeysFromEnv()
): Promise<DiscordConnection> {
  const { orgId, connectedBy, webhook, info } = input;
  requireScope(orgId);
  const row = {
    org_id: orgId,
    webhook_id: webhook.id,
    channel_id: info.channelId,
    guild_id: info.guildId,
    name: info.name,
    webhook_url_enc: encryptSecret(webhook.url, { orgId, column: WEBHOOK_COLUMN }, keys),
    connected_by: connectedBy,
    connected_at: new Date().toISOString(),
    notified_seq: await ledgerHead(),
  };
  const inserted = await platformDb().from("discord_webhooks").insert(row).select(COLUMNS);
  if (inserted.error?.code === "23505" && /discord_webhooks_org_id_key/.test(inserted.error.message ?? "")) throw new DiscordAlreadyConnectedError();
  const [saved] = unwrap(inserted) as unknown as ConnectionRow[];
  await appendLedgerEntryBestEffort(orgId, {
    actor: "human",
    domain: "system",
    action: "discord_connected",
    summary: "Connected a Discord channel: bills waiting for approval are now posted there",
    detail: { by: connectedBy, webhookId: webhook.id, channelId: info.channelId },
  });
  return toConnection(saved);
}

/**
 * Removes a connection (DC1, DC5): from Settings, or because Discord said the webhook is gone. Records it when a row
 * went; answers whether one did. The webhook itself is the channel's, in Discord: it is forgotten here, not deleted there.
 */
export async function removeConnection(connection: DiscordConnection, via: "settings" | "discord", by: string | null): Promise<boolean> {
  requireScope(connection.orgId);
  const deleted = unwrap(await platformDb().from("discord_webhooks").delete().eq("id", connection.id).select("id")) as Array<{ id: string }>;
  if (deleted.length === 0) return false;
  await appendLedgerEntryBestEffort(connection.orgId, {
    actor: via === "discord" ? "system" : "human",
    domain: "system",
    action: "discord_disconnected",
    summary: via === "discord" ? "Discord said the channel's webhook is gone, so it was disconnected" : "Disconnected the workspace's Discord channel",
    detail: { by, webhookId: connection.webhookId, via },
  });
  return true;
}

/** Moves the channel's cursor to `seq`, never back. */
export async function moveCursor(connectionId: string, seq: number): Promise<void> {
  const result = await platformDb().from("discord_webhooks").update({ notified_seq: seq }).eq("id", connectionId).lt("notified_seq", seq);
  if (result.error) throw new Error(result.error.message);
}

/** Records a post Discord did not take (DC5): what it said, when, and one more in a row. */
export async function recordFailure(connection: DiscordConnection, error: string, at: Date = new Date()): Promise<void> {
  const said = error.length <= LAST_ERROR_MAX ? error : `${error.slice(0, LAST_ERROR_MAX - 1)}…`;
  const result = await platformDb()
    .from("discord_webhooks")
    .update({ last_error: said, last_error_at: at.toISOString(), failures: connection.failures + 1 })
    .eq("id", connection.id);
  if (result.error) throw new Error(result.error.message);
}

/** Clears the failure once Discord took a post (DC5). */
export async function clearFailure(connectionId: string): Promise<void> {
  const result = await platformDb().from("discord_webhooks").update({ last_error: null, last_error_at: null, failures: 0 }).eq("id", connectionId);
  if (result.error) throw new Error(result.error.message);
}
