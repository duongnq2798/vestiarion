import crypto from "node:crypto";

/**
 * The check every request from Slack passes before its body is read (Slack design S2). Slack signs
 * `v0:<X-Slack-Request-Timestamp>:<raw body>` with the app's signing secret and sends `v0=<hex HMAC-SHA256>` as
 * `X-Slack-Signature`. The comparison is in constant time, and a timestamp more than five minutes from now is refused,
 * which bounds how long a captured request could be replayed. Pure: no I/O, no logging.
 */

export const SLACK_SIGNATURE_TOLERANCE_S = 300;

const TIMESTAMP = /^\d{1,15}$/;
const SIGNATURE = /^v0=[0-9a-f]{64}$/;

export function verifySlackRequest(
  request: { signature: string | null; timestamp: string | null; body: string },
  signingSecret: string,
  nowMs: number = Date.now()
): boolean {
  const { signature, timestamp, body } = request;
  if (!signature || !timestamp || !TIMESTAMP.test(timestamp) || !SIGNATURE.test(signature)) return false;
  if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > SLACK_SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(`v0=${crypto.createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`, "utf8").digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** The three things the check needs, from a route's request and the body it read as text. */
export function slackRequestOf(request: Request, body: string): { signature: string | null; timestamp: string | null; body: string } {
  return { signature: request.headers.get("x-slack-signature"), timestamp: request.headers.get("x-slack-request-timestamp"), body };
}
