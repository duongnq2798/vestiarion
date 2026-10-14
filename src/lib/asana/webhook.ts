import crypto from "node:crypto";
import { HANDSHAKE_WINDOW_MS, type StoredWebhook, type WebhookStore } from "./webhook-store";

/**
 * Asana's webhook for one linked task (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A11, A12), at
 * `/api/integrations/asana/webhook/<id>`, the id Vestiarion made for it.
 *
 * - **The handshake.** Asana, asked to make the webhook, first POSTs to the address with `X-Hook-Secret`. It is taken
 *   once, for a row still waiting for it, within two minutes of the row being made; the secret is kept sealed, and sent
 *   back in the same header with 200. Any later handshake for the row is refused. Once Asana answers the request that
 *   made the webhook, the secret in its answer is compared with the one kept (`./webhooks.ts`), and a webhook whose
 *   secret differs is deleted.
 * - **Events.** `X-Hook-Signature` is the hex HMAC-SHA256 of the raw body under that secret, compared in constant time
 *   before anything else is done. A signed delivery only nudges: the linked task is read again through Asana's API
 *   after the answer. Nothing in the body is believed or kept, not even which task changed: an event can say a task was
 *   completed, but only Asana's API, asked by Vestiarion, says so.
 * - **Gone.** A row deleted (unlinked, disconnected) or unknown answers 410, which tells Asana to delete the webhook.
 */

/** Asana sets no limit on a delivery's size; this endpoint takes up to 1 MB. */
export const MAX_BODY_BYTES = 1_000_000;

const HEX64 = /^[0-9a-f]{64}$/i;
const SECRET = /^[\x21-\x7e]{8,500}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether `X-Hook-Signature` is the HMAC-SHA256 of this exact body under the secret, compared in constant time. */
export function verifyAsanaSignature(secret: string, rawBody: string, header: string | null): boolean {
  const given = header?.trim() ?? "";
  if (!HEX64.test(given)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(given, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export interface AsanaWebhookDeps {
  store: WebhookStore;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  /** Reads the webhook's linked task again, in its workspace's scope. */
  reread: (webhook: StoredWebhook) => Promise<unknown>;
  now?: () => number;
}

const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

export async function handleAsanaWebhook(request: Request, id: string, deps: AsanaWebhookDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  if (!UUID.test(id)) return empty(404);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return empty(413);
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return empty(413);

  const webhook = await deps.store.find(id);
  // Unknown, or deleted when its task was unlinked or Asana disconnected: Asana deletes a webhook that answers 410.
  if (!webhook || webhook.state === "deleted") return empty(410);

  const handshake = request.headers.get("x-hook-secret");
  if (handshake !== null) {
    const fresh = now() - Date.parse(webhook.createdAt) <= HANDSHAKE_WINDOW_MS;
    if (webhook.state !== "pending" || webhook.secret !== null || !fresh || !SECRET.test(handshake)) return empty(403);
    if (!(await deps.store.saveSecret(webhook, handshake))) return empty(403);
    return empty(200, { "X-Hook-Secret": handshake });
  }

  if (!webhook.secret || !verifyAsanaSignature(webhook.secret, rawBody, request.headers.get("x-hook-signature"))) return empty(401);
  await deps.store.touch(webhook.id, new Date(now()).toISOString());
  // A heartbeat (no events) reads nothing; any event reads the task again, after the answer.
  if (!/"events"\s*:\s*\[\s*\]/.test(rawBody)) {
    deps.defer(async () => {
      try {
        await deps.reread(webhook);
      } catch (error) {
        console.error("asana webhook: the task was not read again", webhook.id, error instanceof Error ? error.name : "unknown");
      }
    });
  }
  return empty(200);
}
