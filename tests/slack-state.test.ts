import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseMasterKeys } from "@/lib/secrets";
import { addressHash, CARD_TTL_MS, cardToken, oauthState, readCard, readOAuthState, STATE_TTL_MS } from "@/lib/slack/state";

/**
 * What Vestiarion signs and Slack carries back (Slack design S3, S9): the OAuth state that ties an install to the
 * person who started it, and the card a button carries. Both are HMAC-signed under keys derived from the master key,
 * one per purpose, and expire; a card signed under an older master key still reads after a rotation.
 */

const key = () => `${crypto.randomBytes(32).toString("base64")}`;
const KEYS = parseMasterKeys(`k2:${key()},k1:${key()}`);
const OLD_ONLY = [KEYS[1]];
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d01";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000d2";

const card = { org: ORG, invoice: INVOICE, decidedAt: "2026-10-03T11:58:00.000Z", addressHash: "0123456789abcdef" };

describe("the card a button carries (S9)", () => {
  it("reads back what was signed, for seven days", () => {
    const token = cardToken(card, KEYS, NOW);
    expect(token.startsWith("vx1.")).toBe(true);
    expect(token.length).toBeLessThan(2000);
    expect(readCard(token, KEYS, NOW + CARD_TTL_MS - 1)).toEqual(card);
    expect(readCard(token, KEYS, NOW + CARD_TTL_MS)).toBeNull();
  });

  it("keeps a payable decided at no recorded moment, and one with no address", () => {
    const blank = { ...card, decidedAt: null, addressHash: null };
    expect(readCard(cardToken(blank, KEYS, NOW), KEYS, NOW)).toEqual(blank);
  });

  it("refuses a card whose payload or signature was changed", () => {
    const [prefix, body, mac] = cardToken(card, KEYS, NOW).split(".");
    const other = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")), i: crypto.randomUUID() })).toString("base64url");
    expect(readCard(`${prefix}.${other}.${mac}`, KEYS, NOW)).toBeNull();
    const flipped = `${mac.slice(0, -2)}${mac.endsWith("AA") ? "BB" : "AA"}`;
    expect(readCard(`${prefix}.${body}.${flipped}`, KEYS, NOW)).toBeNull();
    expect(readCard("garbage", KEYS, NOW)).toBeNull();
  });

  it("still reads a card signed before the master key was rotated", () => {
    const token = cardToken(card, OLD_ONLY, NOW);
    expect(readCard(token, KEYS, NOW)).toEqual(card);
  });

  it("is not an OAuth state, and an OAuth state is not a card", () => {
    const state = oauthState({ org: ORG, user: USER, nonce: "n".repeat(43) }, KEYS, NOW);
    expect(readCard(state, KEYS, NOW)).toBeNull();
    expect(readOAuthState(cardToken(card, KEYS, NOW), KEYS, NOW)).toBeNull();
  });
});

describe("the OAuth state (S3)", () => {
  it("reads back for ten minutes, then not", () => {
    const state = oauthState({ org: ORG, user: USER, nonce: "n".repeat(43) }, KEYS, NOW);
    expect(readOAuthState(state, KEYS, NOW + STATE_TTL_MS - 1)).toEqual({ org: ORG, user: USER, nonce: "n".repeat(43) });
    expect(readOAuthState(state, KEYS, NOW + STATE_TTL_MS)).toBeNull();
  });
});

describe("addressHash", () => {
  it("is the first 16 hex of the SHA-256 of the address, whatever its case, and null for none", () => {
    const address = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    const expected = crypto.createHash("sha256").update(address.toLowerCase()).digest("hex").slice(0, 16);
    expect(addressHash(address)).toBe(expected);
    expect(addressHash(address.toLowerCase())).toBe(expected);
    expect(addressHash(null)).toBeNull();
    expect(addressHash("")).toBeNull();
  });
});
