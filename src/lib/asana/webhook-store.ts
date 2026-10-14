import crypto from "node:crypto";
import { currentOrgId } from "../context";
import { platformDb, unwrap } from "../dal";
import { decryptSecret, encryptSecret, masterKeysFromEnv, type MasterKey, type SecretEnvelope } from "../secrets";

/**
 * The one module that reads or writes Asana webhooks (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md
 * A11, A12). `asana_webhooks` is a platform table only the service role reaches (migration 0115), as
 * `accounting_tokens` is: the secret Asana sent in its handshake is an envelope under the master key bound to the
 * workspace, the column and the row, so a ciphertext copied into another row does not open. Every function but the
 * webhook route's lookup and handshake names the workspace in scope; the route, which has only the id in Asana's target
 * address, reads one row by that id and nothing else.
 */

const SECRET = "asana_webhooks.secret_enc";
const columnOf = (id: string) => `${SECRET}/${id}`;

/** How long after a webhook row is made Asana's handshake is taken for it. */
export const HANDSHAKE_WINDOW_MS = 2 * 60_000;

export type WebhookState = "pending" | "active" | "deleted";

export interface StoredWebhook {
  id: string;
  orgId: string;
  connectionId: string;
  linkId: string;
  resourceGid: string;
  webhookGid: string | null;
  state: WebhookState;
  /** The handshake's secret, opened; null before the handshake. */
  secret: string | null;
  createdAt: string;
}

interface WebhookRow {
  id: string;
  org_id: string;
  connection_id: string;
  link_id: string;
  resource_gid: string;
  webhook_gid: string | null;
  state: WebhookState;
  secret_enc: SecretEnvelope | null;
  created_at: string;
}

const COLUMNS = "id, org_id, connection_id, link_id, resource_gid, webhook_gid, state, secret_enc, created_at";

function requireScope(orgId: string): void {
  if (currentOrgId() !== orgId) throw new Error("An Asana webhook is reached only in its own workspace's scope");
}

function opened(row: WebhookRow, keys: MasterKey[]): StoredWebhook {
  return {
    id: row.id,
    orgId: row.org_id,
    connectionId: row.connection_id,
    linkId: row.link_id,
    resourceGid: row.resource_gid,
    webhookGid: row.webhook_gid,
    state: row.state,
    secret: row.secret_enc ? decryptSecret(row.secret_enc, { orgId: row.org_id, column: columnOf(row.id) }, keys) : null,
    createdAt: row.created_at,
  };
}

export interface WebhookStore {
  /** The row for Asana's target address, by its id alone: for the webhook route. */
  find(id: string): Promise<StoredWebhook | null>;
  /** Keeps the handshake's secret, once, while the row waits for it: false when it was taken already or the row moved on. */
  saveSecret(webhook: StoredWebhook, secret: string): Promise<boolean>;
  touch(id: string, nowIso: string): Promise<void>;
}

export function webhookStore(keys: MasterKey[] = masterKeysFromEnv()): WebhookStore {
  return {
    async find(id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
      const rows = unwrap(await platformDb().from("asana_webhooks").select(COLUMNS).eq("id", id).limit(1)) as WebhookRow[];
      return rows[0] ? opened(rows[0], keys) : null;
    },
    async saveSecret(webhook, secret) {
      const sealed = encryptSecret(secret, { orgId: webhook.orgId, column: columnOf(webhook.id) }, keys);
      const rows = unwrap(
        await platformDb()
          .from("asana_webhooks")
          .update({ secret_enc: sealed, handshake_at: new Date().toISOString() })
          .eq("id", webhook.id)
          .eq("org_id", webhook.orgId)
          .eq("state", "pending")
          .is("secret_enc", null)
          .select("id")
      ) as Array<{ id: string }>;
      return rows.length === 1;
    },
    async touch(id, nowIso) {
      unwrap(await platformDb().from("asana_webhooks").update({ last_event_at: nowIso }).eq("id", id).select("id"));
    },
  };
}

/** A new row for a linked task's webhook, made before Asana is asked, so its handshake finds it. Returns its id. */
export async function newWebhook(input: { orgId: string; connectionId: string; linkId: string; resourceGid: string }): Promise<string> {
  requireScope(input.orgId);
  const id = crypto.randomUUID();
  unwrap(
    await platformDb()
      .from("asana_webhooks")
      .insert({ id, org_id: input.orgId, connection_id: input.connectionId, link_id: input.linkId, resource_gid: input.resourceGid })
      .select("id")
  );
  return id;
}

/** The webhook Asana made: active from now, with its id at Asana. */
export async function activateWebhook(orgId: string, id: string, webhookGid: string): Promise<boolean> {
  requireScope(orgId);
  const rows = unwrap(
    await platformDb()
      .from("asana_webhooks")
      .update({ state: "active", webhook_gid: webhookGid })
      .eq("id", id)
      .eq("org_id", orgId)
      .eq("state", "pending")
      .not("secret_enc", "is", null)
      .select("id")
  ) as Array<{ id: string }>;
  return rows.length === 1;
}

/** Marked deleted: its address answers 410 from now, which tells Asana to delete it too. */
export async function markWebhookDeleted(orgId: string, id: string, nowIso: string): Promise<void> {
  requireScope(orgId);
  unwrap(await platformDb().from("asana_webhooks").update({ state: "deleted", deleted_at: nowIso }).eq("id", id).eq("org_id", orgId).select("id"));
}

/** The webhooks not deleted, of a link or of a connection, in the workspace in scope: ids and Asana's ids only. */
export async function liveWebhooks(orgId: string, where: { linkId: string } | { connectionId: string }): Promise<Array<{ id: string; webhookGid: string | null }>> {
  requireScope(orgId);
  const query = platformDb().from("asana_webhooks").select("id, webhook_gid").eq("org_id", orgId).neq("state", "deleted");
  const rows = unwrap(await ("linkId" in where ? query.eq("link_id", where.linkId) : query.eq("connection_id", where.connectionId)).limit(200)) as Array<{ id: string; webhook_gid: string | null }>;
  return rows.map((row) => ({ id: row.id, webhookGid: row.webhook_gid }));
}

/** The secret a row kept, opened, to compare with the one Asana's answer carried; null before the handshake. */
export async function webhookSecret(orgId: string, id: string, keys: MasterKey[] = masterKeysFromEnv()): Promise<string | null> {
  requireScope(orgId);
  const rows = unwrap(await platformDb().from("asana_webhooks").select(COLUMNS).eq("id", id).eq("org_id", orgId).limit(1)) as WebhookRow[];
  return rows[0] ? opened(rows[0], keys).secret : null;
}
