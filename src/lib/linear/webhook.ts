import crypto from "node:crypto";
import { UUID } from "./http";

/**
 * Linear's app webhook (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN11), at
 * `/api/integrations/linear/webhook`: one address and one signing secret for the OAuth app, which Linear calls for every
 * Linear workspace that authorized it.
 *
 * - **Checked first.** `Linear-Signature` is the hex HMAC-SHA256 of the raw body under `LINEAR_WEBHOOK_SECRET`,
 *   compared in constant time before the body is read for anything; then its `webhookTimestamp` (Unix milliseconds)
 *   must be within 60 seconds of receipt. Either failing answers 401, and nothing is read.
 * - **Only a nudge.** A signed delivery is answered 200 at once. After the answer, the one issue it names (an `Issue`'s
 *   own id, a `Comment`'s or an `Attachment`'s `issueId`) is read again through Linear's API, in each Vestiarion
 *   workspace connected to the delivery's Linear workspace, and only where it is linked. Nothing else in the body is
 *   believed or kept: no state, deliverable or person comes from it.
 * - **Revoked.** An `OAuthApp` revoked delivery marks the connections to that Linear workspace as needing to reconnect.
 */

/** Linear sets no limit on a delivery's size; this endpoint takes up to 1 MB. */
export const MAX_BODY_BYTES = 1_000_000;
/** How far a delivery's `webhookTimestamp` may be from its receipt. */
export const TIMESTAMP_WINDOW_MS = 60_000;

const HEX64 = /^[0-9a-f]{64}$/i;

/** Whether `Linear-Signature` is the HMAC-SHA256 of this exact body under the secret, compared in constant time. */
export function verifyLinearSignature(secret: string, rawBody: string, header: string | null): boolean {
  const given = header?.trim() ?? "";
  if (!HEX64.test(given) || secret.length === 0) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
  const actual = Buffer.from(given, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** What a signed delivery asks for: an issue read again, a revoked app, or nothing. */
export type LinearDelivery =
  | { kind: "issue"; organizationId: string; issueId: string }
  | { kind: "revoked"; organizationId: string }
  | { kind: "ignored" };

const record = (value: unknown): Record<string, unknown> | null => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const uuid = (value: unknown): string | null => (typeof value === "string" && UUID.test(value) ? value : null);

/** Which issue a delivery names, and in which Linear workspace: ids alone, each checked to be one. */
export function deliveryOf(body: Record<string, unknown>): LinearDelivery {
  const organizationId = uuid(body.organizationId);
  if (!organizationId) return { kind: "ignored" };
  if (body.type === "OAuthApp") return body.action === "revoked" ? { kind: "revoked", organizationId } : { kind: "ignored" };
  const data = record(body.data);
  const issueId = body.type === "Issue" ? uuid(data?.id) : body.type === "Comment" || body.type === "Attachment" ? uuid(data?.issueId) : null;
  return issueId ? { kind: "issue", organizationId, issueId } : { kind: "ignored" };
}

export interface LinearWebhookDeps {
  /** `LINEAR_WEBHOOK_SECRET`. */
  secret: string;
  /** Runs work after the response: `after()` in the route. */
  defer: (work: () => Promise<void>) => void;
  /** Reads the issue again in every workspace connected to the Linear workspace. */
  reread: (event: { organizationId: string; issueId: string }) => Promise<unknown>;
  /** Marks the connections to the Linear workspace as needing to reconnect. */
  revoked: (organizationId: string) => Promise<unknown>;
  now?: () => number;
}

const empty = (status: number) => new Response(null, { status });

export async function handleLinearWebhook(request: Request, deps: LinearWebhookDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return empty(413);
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return empty(413);

  if (!verifyLinearSignature(deps.secret, rawBody, request.headers.get("linear-signature"))) return empty(401);
  let body: Record<string, unknown> | null;
  try {
    body = record(JSON.parse(rawBody));
  } catch {
    body = null;
  }
  const sentAt = typeof body?.webhookTimestamp === "number" ? body.webhookTimestamp : Number.NaN;
  // A delivery replayed later, or one whose time is not a number, is refused as an unsigned one is.
  if (!body || !Number.isFinite(sentAt) || Math.abs(now - sentAt) > TIMESTAMP_WINDOW_MS) return empty(401);

  const delivery = deliveryOf(body);
  if (delivery.kind === "issue") {
    const event = { organizationId: delivery.organizationId, issueId: delivery.issueId };
    deps.defer(async () => {
      try {
        await deps.reread(event);
      } catch (error) {
        console.error("linear webhook: the issue was not read again", error instanceof Error ? error.name : "unknown");
      }
    });
  } else if (delivery.kind === "revoked") {
    const organizationId = delivery.organizationId;
    deps.defer(async () => {
      try {
        await deps.revoked(organizationId);
      } catch (error) {
        console.error("linear webhook: a revocation was not recorded", error instanceof Error ? error.name : "unknown");
      }
    });
  }
  return empty(200);
}
