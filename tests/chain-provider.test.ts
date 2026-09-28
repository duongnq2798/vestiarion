import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { chainModes, getChainProvider } from "@/lib/circle";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * R12: an organization's Circle credentials can be *stored* but unreadable —
 * sealed under a master key this deployment no longer holds, or corrupted in
 * transit. That must never look like "no Circle credentials configured",
 * which is sandbox mode and would let a live organization's payments quietly
 * simulate while its invoices are marked paid (spec §5.4).
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

function withUnreadableCredentials(reason: string) {
  return { ...config, chain: { ...config.chain, credentialsUnreadable: reason } };
}

describe("getChainProvider — stored Circle credentials that cannot be read", () => {
  it("refuses rather than falling back to simulated payments", () => {
    const reason = "could not decrypt circle_api_key_enc of organization x: wrong master key, or the ciphertext was altered or moved";
    runWith({ config: withUnreadableCredentials(reason), db: fakeSupabase().client, orgId: ORG, platformConfig: config }, () => {
      expect(() => getChainProvider()).toThrow(
        `This organization's Circle credentials are stored but could not be read (${reason}); refusing to fall back to simulated payments`
      );
    });
  });

  it("does not refuse an organization with no stored Circle credentials at all", () => {
    runWith({ config, db: fakeSupabase().client, orgId: ORG, platformConfig: config }, () => {
      expect(() => getChainProvider()).not.toThrow();
      expect(getChainProvider().mode).toBe("simulate");
    });
  });
});

describe("chainModes — must render a page even when getChainProvider() refuses", () => {
  it("reports simulate/simulate without constructing a provider", () => {
    const reason = "could not decrypt circle_entity_secret_enc of organization x: wrong master key, or the ciphertext was altered or moved";
    runWith({ config: withUnreadableCredentials(reason), db: fakeSupabase().client, orgId: ORG, platformConfig: config }, () => {
      expect(chainModes()).toEqual({ mode: "simulate", earnMode: "simulate" });
    });
  });

  it("still reports the real provider's modes when credentials are readable", () => {
    runWith({ config, db: fakeSupabase().client, orgId: ORG, platformConfig: config }, () => {
      expect(chainModes()).toEqual({ mode: "simulate", earnMode: "simulate" });
    });
  });
});
