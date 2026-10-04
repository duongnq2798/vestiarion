import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { githubWebhookSecretFromEnv, readCommentCommand, verifyWebhookSignature } from "@/lib/github/webhook";

/**
 * Bounties from a pull request comment (docs/superpowers/specs/2026-10-04-github-bounties-design.md B1, B2): GitHub's
 * signature on each delivery, and the two commands a comment can carry.
 */

const SECRET = "a-webhook-secret-for-tests";
const sign = (body: string, secret = SECRET) => `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;

describe("verifyWebhookSignature (B2)", () => {
  const body = JSON.stringify({ action: "created", comment: { body: "/bounty 5" } });

  it("accepts GitHub's HMAC-SHA256 of the raw body", () => {
    expect(verifyWebhookSignature(SECRET, body, sign(body))).toBe(true);
  });

  it("refuses a signature made with another secret, or over another body", () => {
    expect(verifyWebhookSignature(SECRET, body, sign(body, "another-secret"))).toBe(false);
    expect(verifyWebhookSignature(SECRET, `${body} `, sign(body))).toBe(false);
  });

  it("refuses a missing header, the old sha1 header, and a digest of the wrong length", () => {
    expect(verifyWebhookSignature(SECRET, body, null)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, `sha1=${crypto.createHmac("sha1", SECRET).update(body).digest("hex")}`)).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha256=abc")).toBe(false);
    expect(verifyWebhookSignature(SECRET, body, "sha256=")).toBe(false);
  });
});

describe("readCommentCommand (B1)", () => {
  it("reads a bounty, with or without USDC, in any case", () => {
    expect(readCommentCommand("/bounty 25")).toEqual({ kind: "bounty", amount: "25" });
    expect(readCommentCommand("/bounty 0.5 USDC")).toEqual({ kind: "bounty", amount: "0.5" });
    expect(readCommentCommand("/Bounty 12.345678 usdc")).toEqual({ kind: "bounty", amount: "12.345678" });
  });

  it("reads the command from its own line, after other text, and only the first one", () => {
    expect(readCommentCommand("Thanks for this!\n\n/bounty 10\n/bounty 99")).toEqual({ kind: "bounty", amount: "10" });
    expect(readCommentCommand("Thanks!\r\n  /payto 0x19801dAA8a1d6B3a3E3d3E4bA6e9cC4f2aA0b5c1  \r\n")).toEqual({
      kind: "payto",
      address: "0x19801dAA8a1d6B3a3E3d3E4bA6e9cC4f2aA0b5c1",
    });
  });

  it("says when a command is there but its argument is not usable, so the reply can show the right form", () => {
    expect(readCommentCommand("/bounty")).toEqual({ kind: "bounty_invalid" });
    expect(readCommentCommand("/bounty five dollars")).toEqual({ kind: "bounty_invalid" });
    expect(readCommentCommand("/bounty 5 EURC")).toEqual({ kind: "bounty_invalid" });
    expect(readCommentCommand("/bounty 1.1234567")).toEqual({ kind: "bounty_invalid" });
    expect(readCommentCommand("/payto my-wallet")).toEqual({ kind: "payto_invalid" });
    expect(readCommentCommand("/payto 0x1234")).toEqual({ kind: "payto_invalid" });
  });

  it("ignores a command in the middle of a line, in a quote, or in a fenced code block", () => {
    expect(readCommentCommand("You can reply with `/payto 0xabc` here")).toBeNull();
    expect(readCommentCommand("> /bounty 5\nquoting the maintainer")).toBeNull();
    expect(readCommentCommand("Use it like this:\n```\n/bounty 5\n```")).toBeNull();
    expect(readCommentCommand("```\n/bounty 5\n```\n/bounty 7")).toEqual({ kind: "bounty", amount: "7" });
  });

  it("ignores other slash words and plain comments", () => {
    expect(readCommentCommand("/bountyhunter 5")).toBeNull();
    expect(readCommentCommand("/assign me")).toBeNull();
    expect(readCommentCommand("LGTM")).toBeNull();
    expect(readCommentCommand("")).toBeNull();
  });
});

describe("githubWebhookSecretFromEnv (B2)", () => {
  it("is the trimmed secret, or null when it is not set", () => {
    expect(githubWebhookSecretFromEnv({ GITHUB_APP_WEBHOOK_SECRET: `  ${SECRET}\n` })).toBe(SECRET);
    expect(githubWebhookSecretFromEnv({ GITHUB_APP_WEBHOOK_SECRET: "   " })).toBeNull();
    expect(githubWebhookSecretFromEnv({})).toBeNull();
  });
});
