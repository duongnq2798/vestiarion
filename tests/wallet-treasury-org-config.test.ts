import { describe, expect, it } from "vitest";
import { configFromEnv, walletTreasuryAvailable, type VestiarionConfig } from "@/lib/config";
import { orgConfig, WALLET_TREASURY_NOT_CONFIGURED, type OrgRow } from "@/lib/dal/org-config";
import { AGENT_WALLET_SET, walletSetName } from "@/lib/circle/provision";
import { MAINNET_OFF } from "@/lib/mainnet";
import { ARC_MAINNET } from "@/lib/network";

/**
 * A workspace paying from its owner's own wallet gets Vestiarion's agent account on Arc mainnet as its Circle
 * credentials, and only it does (docs/superpowers/specs/2026-10-07-wallet-treasury-design.md W1, W4): the pair leaves
 * under no key of its own, as the hosted pair does not (hosted wallets R4).
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const AGENT_KEY = "LIVE_API_KEY:agent-key-must-not-leak:x";
const AGENT_SECRET = "agent-entity-secret-must-not-leak";
const ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  MAINNET_ENABLED: "1",
  MAINNET_AGENT_CIRCLE_API_KEY: AGENT_KEY,
  MAINNET_AGENT_CIRCLE_ENTITY_SECRET: AGENT_SECRET,
  HOSTED_CIRCLE_API_KEY: "hosted-key",
  HOSTED_CIRCLE_ENTITY_SECRET: "hosted-secret",
};
const base = configFromEnv(ENV);

function org(walletHost: OrgRow["wallet_host"], network: OrgRow["network"] = "arc-mainnet"): OrgRow {
  return {
    id: ORG,
    slug: "own-wallet-co",
    name: "Own Wallet Co",
    mode: "sandbox",
    ledger_signing_key_enc: null,
    circle_api_key_enc: null,
    circle_entity_secret_enc: null,
    wallet_host: walletHost,
    ledger_retired_keys: [],
    network,
  };
}

const holdsNoAgentPair = (config: VestiarionConfig) => {
  const text = JSON.stringify(config);
  expect(text).not.toContain(AGENT_KEY);
  expect(text).not.toContain(AGENT_SECRET);
  expect(Object.keys(config.chain)).not.toContain("mainnetAgentCircleApiKey");
  expect(Object.keys(config.chain)).not.toContain("mainnetAgentCircleEntitySecret");
};

describe("orgConfig and a wallet treasury", () => {
  it("gives a workspace paying from its owner's wallet on Arc mainnet the agent account, and says it is offered", () => {
    const { config, warnings } = orgConfig(base, org("external"), null);
    expect(config.chain.circleApiKey).toBe(AGENT_KEY);
    expect(config.chain.circleEntitySecret).toBe(AGENT_SECRET);
    expect(config.chain.walletHost).toBe("external");
    expect(config.chain.credentialsUnreadable).toBeUndefined();
    expect(config.chain.walletTreasuryAvailable).toBe(true);
    expect(walletTreasuryAvailable(config, ARC_MAINNET)).toBe(true);
    expect(warnings).toEqual([]);
    expect(Object.keys(config.chain)).not.toContain("mainnetAgentCircleApiKey");
  });

  it("never gives the agent pair to any other workspace, under any key", () => {
    for (const host of ["own", "hosted", null] as const) {
      for (const network of ["arc-mainnet", "arc-testnet"] as const) {
        const { config } = orgConfig(base, org(host, network), null);
        holdsNoAgentPair(config);
        expect(config.chain.walletTreasuryAvailable, `${host} on ${network}`).toBe(true);
      }
    }
  });

  it("refuses by name on a deployment without the agent account, or with a test key in it", () => {
    for (const env of [{ ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: undefined }, { ...ENV, MAINNET_AGENT_CIRCLE_API_KEY: "TEST_API_KEY:a:b" }]) {
      const { config, warnings } = orgConfig(configFromEnv(env), org("external"), null);
      expect(config.chain.circleApiKey).toBeUndefined();
      expect(config.chain.credentialsUnreadable).toBe(WALLET_TREASURY_NOT_CONFIGURED);
      expect(config.chain.walletTreasuryAvailable).toBe(false);
      expect(warnings).toContain(WALLET_TREASURY_NOT_CONFIGURED);
    }
  });

  it("withholds the agent pair while Arc mainnet is switched off", () => {
    const { config } = orgConfig(configFromEnv({ ...ENV, MAINNET_ENABLED: undefined }), org("external"), null);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe(MAINNET_OFF);
  });

  it("refuses a wallet treasury on a network that does not offer one, by name", () => {
    const { config } = orgConfig(base, org("external", "arc-testnet"), null);
    expect(config.chain.circleApiKey).toBeUndefined();
    expect(config.chain.credentialsUnreadable).toBe("Paying from your own wallet does not run on Arc testnet yet");
  });

  it("keeps agent wallets in a set of their own", () => {
    expect(walletSetName(ORG, "external")).toBe(AGENT_WALLET_SET);
    expect(AGENT_WALLET_SET).toBe("vestiarion-agents");
  });
});
