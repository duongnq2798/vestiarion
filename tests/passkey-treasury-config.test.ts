import { describe, expect, it } from "vitest";
import { passkeyTreasuryConfig } from "@/lib/passkey-treasury";

/**
 * The Circle mainnet client key a passkey treasury runs on (docs/superpowers/specs/2026-10-07-passkey-treasury-design.md
 * K11): meant for the browser and bound to the site's domain, with Circle's own client URL unless another is given.
 */

describe("passkeyTreasuryConfig", () => {
  it("takes the key with Circle's client URL when none is given", () => {
    expect(passkeyTreasuryConfig({ key: " LIVE_CLIENT_KEY:abc:def ", url: undefined })).toEqual({
      clientKey: "LIVE_CLIENT_KEY:abc:def",
      clientUrl: "https://modular-sdk.circle.com/v1/rpc/w3s/buidl",
    });
  });

  it("takes a client URL given, without its trailing slashes", () => {
    expect(passkeyTreasuryConfig({ key: "k", url: "https://modular.example/v1/rpc//" })).toEqual({ clientKey: "k", clientUrl: "https://modular.example/v1/rpc" });
  });

  it("is nothing without a key", () => {
    expect(passkeyTreasuryConfig({ key: undefined, url: "https://modular.example" })).toBeNull();
    expect(passkeyTreasuryConfig({ key: "  ", url: undefined })).toBeNull();
  });
});
