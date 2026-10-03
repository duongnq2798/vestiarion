import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { slackRedirectUri, slackSettingsFromEnv } from "@/lib/slack/settings";
import { verifySlackRequest } from "@/lib/slack/verify";

/**
 * Slack's configuration and the check every request from Slack passes before its body is read (Slack design S1, S2):
 * the signature is the HMAC-SHA256 of `v0:<timestamp>:<raw body>` under the signing secret, and the timestamp is within
 * five minutes of now, so a captured request cannot be replayed later.
 */

const SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const BODY = "token=x&team_id=T0TEAM&user_id=U0LINH&command=%2Fvestiarion&text=today";

function sign(body: string, timestamp: number, secret = SECRET): string {
  return `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

describe("verifySlackRequest", () => {
  it("accepts Slack's own signature on the raw body, made now", () => {
    const ts = seconds(NOW);
    expect(verifySlackRequest({ signature: sign(BODY, ts), timestamp: String(ts), body: BODY }, SECRET, NOW)).toBe(true);
  });

  it("refuses a signature made with another secret", () => {
    const ts = seconds(NOW);
    expect(verifySlackRequest({ signature: sign(BODY, ts, "another-secret-of-32-characters!"), timestamp: String(ts), body: BODY }, SECRET, NOW)).toBe(false);
  });

  it("refuses a body changed after it was signed", () => {
    const ts = seconds(NOW);
    expect(verifySlackRequest({ signature: sign(BODY, ts), timestamp: String(ts), body: `${BODY}x` }, SECRET, NOW)).toBe(false);
  });

  it("refuses a request more than five minutes old, or from the future", () => {
    const old = seconds(NOW) - 301;
    expect(verifySlackRequest({ signature: sign(BODY, old), timestamp: String(old), body: BODY }, SECRET, NOW)).toBe(false);
    const ahead = seconds(NOW) + 301;
    expect(verifySlackRequest({ signature: sign(BODY, ahead), timestamp: String(ahead), body: BODY }, SECRET, NOW)).toBe(false);
    const edge = seconds(NOW) - 300;
    expect(verifySlackRequest({ signature: sign(BODY, edge), timestamp: String(edge), body: BODY }, SECRET, NOW)).toBe(true);
  });

  it("refuses a missing or malformed header", () => {
    const ts = seconds(NOW);
    expect(verifySlackRequest({ signature: null, timestamp: String(ts), body: BODY }, SECRET, NOW)).toBe(false);
    expect(verifySlackRequest({ signature: sign(BODY, ts), timestamp: null, body: BODY }, SECRET, NOW)).toBe(false);
    expect(verifySlackRequest({ signature: "v1=abc", timestamp: String(ts), body: BODY }, SECRET, NOW)).toBe(false);
    expect(verifySlackRequest({ signature: sign(BODY, ts), timestamp: "12ab", body: BODY }, SECRET, NOW)).toBe(false);
  });
});

describe("slackSettingsFromEnv", () => {
  const env = { SLACK_CLIENT_ID: "1234567890.9876543210", SLACK_CLIENT_SECRET: "0123456789abcdef0123456789abcdef", SLACK_SIGNING_SECRET: SECRET };

  it("is on only when all three are set", () => {
    expect(slackSettingsFromEnv(env)).toEqual({ clientId: "1234567890.9876543210", clientSecret: env.SLACK_CLIENT_SECRET, signingSecret: SECRET });
    expect(slackSettingsFromEnv({ ...env, SLACK_SIGNING_SECRET: "" })).toBeNull();
    expect(slackSettingsFromEnv({ ...env, SLACK_CLIENT_SECRET: undefined })).toBeNull();
    expect(slackSettingsFromEnv({})).toBeNull();
  });

  it("is off, with a warning that names no value, when the client id is not Slack's shape", () => {
    const warn = console.warn;
    const said: unknown[][] = [];
    console.warn = (...args: unknown[]) => void said.push(args);
    try {
      expect(slackSettingsFromEnv({ ...env, SLACK_CLIENT_ID: "not-an-id" })).toBeNull();
    } finally {
      console.warn = warn;
    }
    expect(said.join(" ")).toContain("SLACK_CLIENT_ID");
    expect(said.join(" ")).not.toContain("not-an-id");
  });

  it("returns the install's callback on the deployment's own origin", () => {
    expect(slackRedirectUri("https://www.vestiarion.xyz")).toBe("https://www.vestiarion.xyz/api/slack/oauth");
  });
});
