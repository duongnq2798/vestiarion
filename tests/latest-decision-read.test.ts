import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the landing reads for its latest decision (docs/superpowers/specs/2026-10-08-landing-owner-hero-design.md R4):
 * `latest_team_decision()` through the platform's functions, the public keys of the workspace that signed it, and the
 * view in words. The workspace's id stays on the server; a read that fails, or a function not yet migrated, shows nothing.
 */

const { rpc, scopes } = vi.hoisted(() => ({ rpc: vi.fn(), scopes: [] as string[] }));
vi.mock("@/lib/dal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal")>()),
  platformDb: () => ({ rpc }),
}));
vi.mock("@/lib/dal/scope", () => ({
  withOrg: async (orgId: string, fn: () => Promise<unknown>) => {
    scopes.push(orgId);
    return fn();
  },
}));
vi.mock("@/lib/ledger", () => ({ ledgerPublicKeyPems: () => ({ "0123456789abcdef": "-----BEGIN PUBLIC KEY-----\nMCow\n-----END PUBLIC KEY-----\n" }) }));

import { readLatestDecision } from "@/lib/platform/latest-decision";

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000c0de";
const TX = `0x${"ab".repeat(32)}`;
const FOUND = {
  orgId: ORG,
  seq: 1899,
  ts: "2026-10-08T10:00:00.123456+00:00",
  action: "ap_pay",
  network: "arc-testnet",
  amount: 0.35,
  currency: "USDC",
  decisionMode: "deepseek",
  agreedWithReference: true,
  guardrailBlocked: false,
  guardrailRule: null,
  heldBecause: null,
  resultingStatus: "paid",
  txRef: TX,
  payOn: null,
  verdict: null,
  bodyHash: "b".repeat(64),
  signature: "s".repeat(128),
  prevHash: "p".repeat(64),
  hash: "h".repeat(64),
  signingKeyId: "0123456789abcdef",
};

// Each test reads at its own minute, past the previous one's memo.
let minute = 0;
const at = () => Date.parse("2026-10-08T12:00:00Z") + (minute += 5) * 60_000;

beforeEach(() => {
  rpc.mockReset();
  scopes.length = 0;
});

describe("readLatestDecision", () => {
  it("reads the team's latest decision, with the keys of the workspace that signed it, and never its id", async () => {
    rpc.mockResolvedValue({ data: FOUND, error: null });
    const shown = await readLatestDecision(at());

    expect(rpc).toHaveBeenCalledWith("latest_team_decision");
    expect(scopes).toEqual([ORG]);
    expect(shown).toMatchObject({
      seq: 1899,
      headline: "Paid a 0.35 USDC bill.",
      network: "Arc testnet",
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
      link: { body_hash: FOUND.bodyHash, signature: FOUND.signature, prev_hash: FOUND.prevHash, hash: FOUND.hash, signing_key_id: FOUND.signingKeyId },
      publicKeys: { "0123456789abcdef": expect.stringContaining("PUBLIC KEY") },
    });
    expect(JSON.stringify(shown)).not.toContain(ORG);
  });

  it("reads it once a minute at most", async () => {
    rpc.mockResolvedValue({ data: FOUND, error: null });
    const now = at();
    await readLatestDecision(now);
    await readLatestDecision(now + 30_000);
    expect(rpc).toHaveBeenCalledTimes(1);
    await readLatestDecision(now + 61_000);
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it("reads the payment that followed, and goes without it before 0088 runs", async () => {
    rpc.mockResolvedValue({ data: { ...FOUND, resultingStatus: "held", heldBecause: "shadow_verdict", txRef: null, verdict: "agree", paidTxHash: TX }, error: null });
    expect(await readLatestDecision(at())).toMatchObject({ headline: "Paid a 0.35 USDC bill after a person agreed.", txUrl: `https://explorer.testnet.arc.io/tx/${TX}` });
    // FOUND has no paidTxHash, as 0087's function answers.
    rpc.mockResolvedValue({ data: FOUND, error: null });
    expect(await readLatestDecision(at())).toMatchObject({ headline: "Paid a 0.35 USDC bill." });
  });

  it("is null when the team has decided nothing yet", async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    expect(await readLatestDecision(at())).toBeNull();
  });

  it("is null, never an error, before the migration runs or when the read fails", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: "function public.latest_team_decision() does not exist" } });
    expect(await readLatestDecision(at())).toBeNull();
    rpc.mockResolvedValue({ data: { ...FOUND, network: "somewhere-else" }, error: null });
    expect(await readLatestDecision(at())).toBeNull();
    quiet.mockRestore();
  });
});
