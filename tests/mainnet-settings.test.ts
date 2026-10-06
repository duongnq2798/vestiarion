import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWithConfig } from "@/lib/context";
import { MAINNET_NOT_LIVE, MAINNET_OFF, mayUseMainnet, networkHold } from "@/lib/mainnet";

/**
 * Arc mainnet behind a switch (docs/superpowers/specs/2026-10-06-mainnet-go-live-design.md M1, M4): the deployment's
 * two settings, who they let use Arc mainnet, and why a mainnet workspace cannot move money now.
 */

const env = { NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" };

describe("MAINNET_ENABLED (mainnet go-live M1)", () => {
  it.each([
    ["1", true],
    ["true", true],
    [" YES ", true],
    ["0", false],
    ["on", false],
    ["", false],
    [undefined, false],
  ])("reads %j as %s", (value, on) => {
    expect(configFromEnv({ ...env, MAINNET_ENABLED: value }).mainnetEnabled).toBe(on);
  });
});

describe("MAINNET_ALLOWLIST (M1)", () => {
  it("splits on commas, semicolons and spaces, lower-cases and drops empties", () => {
    expect(configFromEnv({ ...env, MAINNET_ALLOWLIST: " Owner@Acme.test, b@x.test;c@y.test\n\n d@z.test ," }).mainnetAllowlist).toEqual([
      "owner@acme.test",
      "b@x.test",
      "c@y.test",
      "d@z.test",
    ]);
    expect(configFromEnv(env).mainnetAllowlist).toEqual([]);
  });
});

describe("mayUseMainnet (M1)", () => {
  const on = { mainnetEnabled: true, mainnetAllowlist: ["owner@acme.test"] };

  it("allows a listed address, in any case, while Arc mainnet is on", () => {
    expect(mayUseMainnet("Owner@Acme.test", on)).toBe(true);
    expect(mayUseMainnet(" owner@acme.test ", on)).toBe(true);
  });

  it("refuses an unlisted address, no address, or anyone while Arc mainnet is off", () => {
    expect(mayUseMainnet("other@acme.test", on)).toBe(false);
    expect(mayUseMainnet(null, on)).toBe(false);
    expect(mayUseMainnet(undefined, on)).toBe(false);
    expect(mayUseMainnet("owner@acme.test", { ...on, mainnetEnabled: false })).toBe(false);
  });

  it("reads the deployment's settings when none are given", () => {
    const config = configFromEnv({ ...env, MAINNET_ENABLED: "1", MAINNET_ALLOWLIST: "owner@acme.test" });
    expect(runWithConfig(config, () => mayUseMainnet("owner@acme.test"))).toBe(true);
    expect(runWithConfig(configFromEnv(env), () => mayUseMainnet("owner@acme.test"))).toBe(false);
  });
});

describe("networkHold (M4)", () => {
  it("holds nothing on Arc testnet", () => {
    expect(networkHold("arc-testnet", "sandbox", { mainnetEnabled: false })).toBeNull();
    expect(networkHold("arc-testnet", "live", { mainnetEnabled: true })).toBeNull();
  });

  it("holds a mainnet workspace while Arc mainnet is off, and until the workspace is live", () => {
    expect(networkHold("arc-mainnet", "live", { mainnetEnabled: false })).toBe(MAINNET_OFF);
    expect(networkHold("arc-mainnet", "sandbox", { mainnetEnabled: false })).toBe(MAINNET_OFF);
    expect(networkHold("arc-mainnet", "sandbox", { mainnetEnabled: true })).toBe(MAINNET_NOT_LIVE);
    expect(networkHold("arc-mainnet", "live", { mainnetEnabled: true })).toBeNull();
  });

  it("says so in words a person reads", () => {
    expect(MAINNET_OFF).toBe("Arc mainnet is switched off on this deployment.");
    expect(MAINNET_NOT_LIVE).toBe("This workspace is on Arc mainnet and not live yet. Nothing moves until an owner takes it live.");
  });
});
