import crypto from "node:crypto";
import { currentOrgId, NoOrgScopeError } from "../context";
import { platformDb, unwrap } from "../dal";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { encryptSecret, masterKeysFromEnv } from "../secrets";
import { generateWebhookSecret } from "../webhooks/sign";
import { validateWebhookUrl } from "../webhooks/safe-url";

/**
 * Workspace webhook endpoints (docs/superpowers/specs/2026-09-29-webhooks-design.md,
 * W1, W4, W7, W8, §3, §4).
 *
 * An endpoint's id is picked here, before the insert (`crypto.randomUUID()`,
 * ruling R3), because the signing secret's envelope is bound to it —
 * `webhook_secret:<id>` — and that binding has to exist before the row does.
 * `create_webhook_endpoint` (migration 0028) takes the id, holds the
 * organization to 5 active endpoints under an advisory lock, and inserts.
 *
 * The secret itself is generated here, encrypted under the platform master
 * key and handed back once, in the response that creates it. It is never
 * stored in plain text, logged, or read back from this module again — the
 * dispatcher (`../webhooks/deliver`) is the only other place that decrypts
 * it, to sign a request.
 *
 * The ledger records ids only (W8): `webhook_endpoint_created` and
 * `webhook_endpoint_removed` carry `{ by, endpointId }`, never the URL, which
 * may name a customer's own host.
 */

export interface WebhookEndpointRow {
  id: string;
  /** The endpoint's host only — what a non-manager may see. */
  host: string;
  /** The full URL — a manager's view. */
  url: string;
  createdAt: string;
  disabledAt: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export type WebhookErrorCode = "invalid_url" | "webhook_limit_reached" | "not_found";

const MESSAGES: Record<Exclude<WebhookErrorCode, "invalid_url">, string> = {
  webhook_limit_reached: "This workspace already has 5 webhook endpoints. Remove one first.",
  not_found: "No active webhook endpoint with that id in this workspace.",
};

export class WebhookError extends Error {
  constructor(readonly code: WebhookErrorCode, message?: string) {
    super(code === "invalid_url" ? (message ?? "The URL is not valid.") : MESSAGES[code]);
    this.name = "WebhookError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_COLUMNS = "id, url, created_at, disabled_at, consecutive_failures, last_success_at, last_failure_at";

interface StoredEndpoint {
  id: string;
  url: string;
  created_at: string;
  disabled_at: string | null;
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
}

/** The URL's own hostname — all a non-manager sees. Endpoints are always stored as a valid https URL, so this never fails in practice. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function toWebhookEndpointRow(row: StoredEndpoint): WebhookEndpointRow {
  return {
    id: row.id,
    host: hostOf(row.url),
    url: row.url,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
    consecutiveFailures: row.consecutive_failures,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
  };
}

/**
 * The ledger entry goes into the organization's own scope. A server action
 * already runs inside it (`inOrg`); any other caller has the append alone
 * enter it, as that person. (Mirrors `../platform/api-keys.ts`.)
 */
function ledgerScope(orgId: string, actorId: string): { enterScope?: { userId: string } } {
  let scoped: string | null;
  try {
    scoped = currentOrgId();
  } catch (error) {
    if (!(error instanceof NoOrgScopeError)) throw error;
    scoped = null;
  }
  return scoped === orgId ? {} : { enterScope: { userId: actorId } };
}

/**
 * Validates the URL (W6, in the form), picks the endpoint's id, generates and
 * encrypts its signing secret under that id, then creates the row through
 * `create_webhook_endpoint`, which enforces the 5-endpoint limit (W7). The
 * secret is returned once; nothing here keeps a copy of it.
 */
export async function createWebhookEndpoint(input: { orgId: string; actorId: string; url: string }): Promise<{ endpoint: WebhookEndpointRow; secret: string }> {
  const checked = validateWebhookUrl(input.url);
  if (!checked.ok) throw new WebhookError("invalid_url", checked.reason);

  const id = crypto.randomUUID();
  const secret = generateWebhookSecret();
  const secretEnc = encryptSecret(secret, { orgId: input.orgId, column: `webhook_secret:${id}` }, masterKeysFromEnv());

  const result = await platformDb()
    .rpc("create_webhook_endpoint", {
      p_id: id,
      p_org_id: input.orgId,
      p_url: checked.url.href,
      p_secret_enc: secretEnc,
      p_by: input.actorId,
    })
    // Only the list columns come back into the app; the secret envelope never does.
    .select(LIST_COLUMNS)
    .single<StoredEndpoint>();
  if (result.error) {
    if (/^webhook_limit_reached:/.test(result.error.message)) throw new WebhookError("webhook_limit_reached");
    throw new Error(result.error.message);
  }
  const endpoint = toWebhookEndpointRow(result.data as StoredEndpoint);

  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "webhook_endpoint_created",
      summary: "A webhook endpoint was added",
      detail: { by: input.actorId, endpointId: id },
    },
    ledgerScope(input.orgId, input.actorId)
  );

  return { endpoint, secret };
}

/** Every non-removed endpoint of the organization, newest first — never the secret envelope. */
export async function listWebhookEndpoints(orgId: string): Promise<WebhookEndpointRow[]> {
  const rows = unwrap(
    await platformDb()
      .from("webhook_endpoints")
      .select(LIST_COLUMNS)
      .eq("org_id", orgId)
      .is("removed_at", null)
      .order("created_at", { ascending: false })
  ) as unknown as StoredEndpoint[];
  return rows.map(toWebhookEndpointRow);
}

/**
 * Removes an endpoint: sets `removed_at`, fails its still-pending deliveries
 * (they will never be sent), and records `webhook_endpoint_removed`. There is
 * no re-enabling in place (out of scope, §9) — adding it back is a fresh
 * endpoint, with a fresh secret.
 */
export async function removeWebhookEndpoint(input: { orgId: string; actorId: string; endpointId: string }): Promise<void> {
  if (!UUID.test(input.endpointId)) throw new WebhookError("not_found");

  const rows = unwrap(
    await platformDb()
      .from("webhook_endpoints")
      .update({ removed_at: new Date().toISOString() })
      .eq("id", input.endpointId)
      .eq("org_id", input.orgId)
      .is("removed_at", null)
      .select("id")
  ) as Array<{ id: string }>;
  if (rows.length === 0) throw new WebhookError("not_found");

  const failed = await platformDb()
    .from("webhook_deliveries")
    .update({ status: "failed", last_error: "endpoint removed" })
    .eq("endpoint_id", input.endpointId)
    .eq("status", "pending");
  if (failed.error) throw new Error(failed.error.message);

  await appendLedgerEntryBestEffort(
    input.orgId,
    {
      actor: "human",
      domain: "system",
      action: "webhook_endpoint_removed",
      summary: "A webhook endpoint was removed",
      detail: { by: input.actorId, endpointId: input.endpointId },
    },
    ledgerScope(input.orgId, input.actorId)
  );
}
