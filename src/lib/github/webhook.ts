import crypto from "node:crypto";

/**
 * GitHub's deliveries to the app's webhook, and the commands a pull request comment carries
 * (docs/superpowers/specs/2026-10-04-github-bounties-design.md B1, B2). Pure: no network, no database.
 */

/** The secret GitHub signs each delivery with, as the app's webhook settings and Vercel both hold it; null when unset. */
export function githubWebhookSecretFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const secret = env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  return secret ? secret : null;
}

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/** Whether `X-Hub-Signature-256` is GitHub's HMAC-SHA256 of this exact body under the secret, compared in constant time. */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | null): boolean {
  const given = header ? SIGNATURE.exec(header.trim())?.[1] : undefined;
  if (!given) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return crypto.timingSafeEqual(Buffer.from(given, "hex"), expected);
}

export type CommentCommand =
  | { kind: "bounty"; amount: string }
  | { kind: "bounty_invalid" }
  | { kind: "payto"; address: string }
  | { kind: "payto_invalid" };

const COMMAND = /^\/(bounty|payto)(?:\s+(.*))?$/i;
/** A USDC amount: digits, at most 6 decimals, optionally followed by USDC. Whether it is above zero is the schema's. */
const BOUNTY_ARGUMENT = /^(\d+(?:\.\d{1,6})?)(?:\s+usdc)?$/i;
const ARC_ADDRESS_ARGUMENT = /^(0x[0-9a-fA-F]{40})$/;

/**
 * The first command a comment carries (B1): a line of its own that starts with `/bounty` or `/payto`, in any case.
 * A line in a fenced code block or a quote is not a command, so explaining the syntax or quoting someone is not
 * taken as one. Null when the comment carries none.
 */
export function readCommentCommand(body: string): CommentCommand | null {
  let fenced = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = COMMAND.exec(line);
    if (!match) continue;
    const argument = (match[2] ?? "").trim();
    if (match[1].toLowerCase() === "bounty") {
      const amount = BOUNTY_ARGUMENT.exec(argument)?.[1];
      return amount ? { kind: "bounty", amount } : { kind: "bounty_invalid" };
    }
    const address = ARC_ADDRESS_ARGUMENT.exec(argument)?.[1];
    return address ? { kind: "payto", address } : { kind: "payto_invalid" };
  }
  return null;
}
