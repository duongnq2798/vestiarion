import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  NOTIFICATION_TYPES,
  notificationEndpoint,
  notificationPublicKey,
  parseCircleNotification,
  verifyCircleSignature,
} from "@/lib/circle/notifications";

/**
 * Circle's signed transaction notifications (docs/superpowers/specs/2026-10-06-circle-notifications-design.md N2): the
 * envelope, and the ECDSA P-256 / SHA-256 signature Circle puts in X-Circle-Signature, checked against the public key
 * Circle names in X-Circle-Key-Id. A key pair made here stands in for Circle's.
 */

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const publicKeyB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const sign = (raw: string, key: crypto.KeyObject = privateKey) => crypto.sign("sha256", Buffer.from(raw), key).toString("base64");

/** Circle's documented test notification, byte for byte as its docs print it. */
const TEST_BODY =
  '{"subscriptionId":"00000000-0000-0000-0000-000000000000","notificationId":"00000000-0000-0000-0000-000000000000","notificationType":"webhooks.test","notification":{"hello":"world"},"timestamp":"2024-01-26T18:22:19.779834211Z","version":2}';

const OUTBOUND = JSON.stringify({
  subscriptionId: "s1",
  notificationId: "n1",
  notificationType: "transactions.outbound",
  notification: { id: "tx-1", walletId: "w-1", state: "COMPLETE", transactionType: "OUTBOUND", blockchain: "ARC-TESTNET", txHash: "0xabc" },
  timestamp: "2026-10-06T14:00:00Z",
  version: 2,
});

describe("verifyCircleSignature", () => {
  it("accepts the body Circle signed, with the key it names", () => {
    expect(verifyCircleSignature(TEST_BODY, sign(TEST_BODY), publicKeyB64)).toBe(true);
  });

  it("refuses a body changed after signing, another key's signature and garbage, without throwing", () => {
    expect(verifyCircleSignature(TEST_BODY.replace("world", "earth"), sign(TEST_BODY), publicKeyB64)).toBe(false);
    const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    expect(verifyCircleSignature(TEST_BODY, sign(TEST_BODY, other), publicKeyB64)).toBe(false);
    expect(verifyCircleSignature(TEST_BODY, "not-base64!!", publicKeyB64)).toBe(false);
    expect(verifyCircleSignature(TEST_BODY, sign(TEST_BODY), "AAAA")).toBe(false);
  });
});

describe("notificationPublicKey", () => {
  it("fetches a key id once and remembers it, as Circle says a key id's key never changes", async () => {
    const fetchKey = vi.fn(async () => publicKeyB64);
    expect(await notificationPublicKey("key-cache-test", fetchKey)).toBe(publicKeyB64);
    expect(await notificationPublicKey("key-cache-test", fetchKey)).toBe(publicKeyB64);
    expect(fetchKey).toHaveBeenCalledTimes(1);
    expect(fetchKey).toHaveBeenCalledWith("key-cache-test");
  });

  it("remembers nothing when the fetch fails, so the next notification asks again", async () => {
    const fetchKey = vi.fn<(keyId: string) => Promise<string>>().mockRejectedValueOnce(new Error("unreachable")).mockResolvedValueOnce(publicKeyB64);
    await expect(notificationPublicKey("key-retry-test", fetchKey)).rejects.toThrow("unreachable");
    expect(await notificationPublicKey("key-retry-test", fetchKey)).toBe(publicKeyB64);
  });
});

describe("parseCircleNotification", () => {
  it("reads Circle's envelope and the transaction's id, wallet and state", () => {
    expect(parseCircleNotification(OUTBOUND)).toEqual({
      subscriptionId: "s1",
      notificationId: "n1",
      notificationType: "transactions.outbound",
      notification: { id: "tx-1", walletId: "w-1", state: "COMPLETE", transactionType: "OUTBOUND" },
      timestamp: "2026-10-06T14:00:00Z",
    });
    expect(parseCircleNotification(TEST_BODY)).toMatchObject({ notificationType: "webhooks.test" });
  });

  it("refuses what is not the envelope", () => {
    expect(parseCircleNotification("not json")).toBeNull();
    expect(parseCircleNotification("[]")).toBeNull();
    expect(parseCircleNotification(JSON.stringify({ notification: {} }))).toBeNull();
    expect(parseCircleNotification(JSON.stringify({ notificationType: "transactions.outbound", notification: "x" }))).toBeNull();
  });
});

describe("the subscription Vestiarion asks for", () => {
  it("covers transfers out and in, at the production route", () => {
    expect(NOTIFICATION_TYPES).toEqual(["transactions.outbound", "transactions.inbound"]);
    expect(notificationEndpoint("https://www.vestiarion.xyz")).toBe("https://www.vestiarion.xyz/api/circle/notifications");
    expect(notificationEndpoint("https://www.vestiarion.xyz/")).toBe("https://www.vestiarion.xyz/api/circle/notifications");
  });
});
