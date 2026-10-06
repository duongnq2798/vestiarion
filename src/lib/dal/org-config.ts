import crypto from "node:crypto";
import { walletTreasuryAvailable, type VestiarionConfig, type WalletHost } from "../config";
import { decryptSecret, type MasterKey, type SecretEnvelope } from "../secrets";
import { MAINNET_OFF, networkHold } from "../mainnet";
import { ARC_MAINNET, FeatureOffError, networkOf, networkProfile, type Network } from "../network";

export const FOUNDING_ORG_ID = "00000000-0000-4000-8000-000000000001";

export interface OrgRow {
  id: string;
  slug: string;
  name: string;
  mode: "sandbox" | "live";
  ledger_signing_key_enc: SecretEnvelope | null;
  circle_api_key_enc: SecretEnvelope | null;
  circle_entity_secret_enc: SecretEnvelope | null;
  /** Whose Circle account holds the wallets: the workspace's own, the platform's hosted one, or not chosen (0030). */
  wallet_host: WalletHost | null;
  /** Public halves of this workspace's own retired ledger keys: `{ id, publicKeyPem, retiredAt }[]` (0035). */
  ledger_retired_keys?: unknown;
  /** When an owner or admin turned the real USYC reserve on; null while it is simulated (0054). */
  usyc_live_at?: string | null;
  /** The network the workspace pays on (0075); absent on a row read before it, which is Arc testnet. */
  network?: Network | null;
}

export const ORG_SECRET_COLUMNS =
  "id, slug, name, mode, ledger_signing_key_enc, circle_api_key_enc, circle_entity_secret_enc, wallet_host, ledger_retired_keys, usyc_live_at, network";

/**
 * Why a workspace paying from its owner's own wallet has no Circle credentials: this deployment lacks Vestiarion's agent
 * account on Arc mainnet, or holds a key that is not a production one (wallet treasury W4).
 */
export const WALLET_TREASURY_NOT_CONFIGURED = "Vestiarion's agent account on Arc mainnet is not configured on this deployment";

/** Why a hosted organization has no Circle credentials: this deployment lacks the hosted pair (H1, Review Focus 5). */
export const HOSTED_NOT_CONFIGURED = "the hosted Circle account is not configured on this deployment";

type SecretColumn = "ledger_signing_key_enc" | "circle_api_key_enc" | "circle_entity_secret_enc";

/** Exactly one full public PEM block, and nothing after it but whitespace. */
const ONE_PUBLIC_PEM = /^-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----\s*$/;

/**
 * An item of `ledger_retired_keys` the keyring can use, with its key parsed,
 * or `null`. It must be a plain object with a string `id` and a
 * `publicKeyPem` that is exactly one PUBLIC KEY block, holds no private key,
 * and parses as a public key. `retiredAt` is passed through unchecked: a bad
 * time does not stop a key verifying what it signed.
 */
export function readableRetiredKey(
  item: unknown
): { id: string; publicKeyPem: string; key: crypto.KeyObject; retiredAt: unknown } | null {
  if (typeof item !== "object" || item === null) return null;
  const { id, publicKeyPem, retiredAt } = item as { id?: unknown; publicKeyPem?: unknown; retiredAt?: unknown };
  if (typeof id !== "string" || typeof publicKeyPem !== "string") return null;
  if (!ONE_PUBLIC_PEM.test(publicKeyPem)) return null;
  if (publicKeyPem.includes("PRIVATE KEY")) return null;
  if ((publicKeyPem.match(/-----BEGIN /g) ?? []).length !== 1) return null;
  try {
    return { id, publicKeyPem, key: crypto.createPublicKey(publicKeyPem), retiredAt };
  } catch {
    return null;
  }
}

/**
 * The public halves of `ledger_retired_keys`, joined into the same
 * concatenated-PEM-bundle shape `LEDGER_RETIRED_PUBLIC_KEYS` and
 * `ledgerKeyring`/`ledgerReadKeys` (ledger-keys.ts) already expect.
 *
 * Only an item `readableRetiredKey` accepts is trusted. `ledgerKeyring` throws
 * on a private or unreadable block, and `ledgerReadKeys` then drops every
 * retired key with it, so one bad item — truncated, carrying a private block,
 * or garbage between PUBLIC KEY markers — is skipped here instead of ever
 * reaching them; each skip is named in `warnings` rather than losing the row
 * that follows it.
 */
export function retiredKeyBundle(value: unknown, warnings: string[]): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const pems: string[] = [];
  value.forEach((item, i) => {
    const readable = readableRetiredKey(item);
    if (readable) {
      pems.push(readable.publicKeyPem);
    } else {
      warnings.push(`ledger_retired_keys entry ${i + 1} is not a public key; skipped`);
    }
  });
  return pems.length > 0 ? pems.join("\n") : undefined;
}

/**
 * One organization's configuration: the platform's settings, with the
 * organization's name and its own secrets in place of the environment's.
 *
 * Every organization secret is replaced, never merged. An organization with
 * no Circle credentials gets none — not the platform's — because falling back
 * would let a sandbox move the founding organization's money. A secret that
 * cannot be opened is left unset and reported: reading carries on with a
 * warning, and signing or paying fails loudly for want of the key (§8).
 *
 * A sandbox does not get the platform's screening service either: it screens
 * against the bundled list, as it simulates its payments (sandbox screening).
 *
 * The one exception is explicit, never a fallback (hosted wallets H1, H7): an
 * organization whose own row says `wallet_host = 'hosted'` pays with the
 * platform's hosted Circle pair, and only then. One whose row says `'own'` or
 * nothing keeps exactly the rule above, however its own credentials fare. A
 * hosted organization on a deployment without the hosted pair gets
 * `credentialsUnreadable`, so it refuses to pay rather than simulating.
 */
export function orgConfig(
  base: VestiarionConfig,
  org: OrgRow,
  keys: MasterKey[] | { unavailable: string } | null
): { config: VestiarionConfig; warnings: string[] } {
  const warnings: string[] = [];
  const open = (column: SecretColumn): string | undefined => {
    const envelope = org[column];
    if (!envelope) return undefined;
    if (!keys) {
      warnings.push(`${column} is stored, but VESTIARION_MASTER_KEYS is not set`);
      return undefined;
    }
    if (!Array.isArray(keys)) {
      // Set, but unparseable — a broken deployment, not a missing optional.
      // Reading still carries on: this secret is left unset and reported,
      // same as any other key it cannot open.
      warnings.push(`${column} is stored, but ${keys.unavailable}`);
      return undefined;
    }
    try {
      return decryptSecret(envelope, { orgId: org.id, column }, keys);
    } catch (error) {
      warnings.push((error as Error).message);
      return undefined;
    }
  };

  /**
   * A stored Circle secret this deployment could not open must not be
   * indistinguishable from "no Circle credentials configured" — that reads as
   * sandbox mode, and would let `getChainProvider()` silently simulate a live
   * organization's payments instead of refusing to pay (spec §5.4, R12).
   * `open()` above already pushed a warning for the column that failed; the
   * first such failure is enough to say so.
   */
  let credentialsUnreadable: string | undefined;
  const openCircleSecret = (column: "circle_api_key_enc" | "circle_entity_secret_enc"): string | undefined => {
    const before = warnings.length;
    const value = open(column);
    if (org[column] && value === undefined) credentialsUnreadable ??= warnings[before];
    return value;
  };
  const columnRetiredBundle = retiredKeyBundle(org.ledger_retired_keys, warnings);
  // Ruling R4: the platform pair leaves under no key of its own. A hosted
  // organization receives it as its Circle credentials, below; every other
  // organization never holds it at all, only whether it exists.
  // The agent account on Arc mainnet leaves the same way (wallet treasury W4): only a workspace whose own row says
  // `external` pays with it, and every other one holds only whether it exists.
  const { hostedCircleApiKey, hostedCircleEntitySecret, mainnetAgentCircleApiKey, mainnetAgentCircleEntitySecret, ...platformChain } = base.chain;
  const hostedAvailable = Boolean(hostedCircleApiKey && hostedCircleEntitySecret);
  const agentAccountReady = walletTreasuryAvailable(base, ARC_MAINNET);
  const walletHost = org.wallet_host === "hosted" || org.wallet_host === "own" || org.wallet_host === "external" ? org.wallet_host : null;

  let circleApiKey: string | undefined;
  let circleEntitySecret: string | undefined;
  if (walletHost === "hosted") {
    // The hosted pair, whole or not at all. A hosted organization's own
    // credential columns are not opened: it pays from the platform's hosted
    // entity only, and switching to its own account clears the choice (H4).
    if (hostedCircleApiKey && hostedCircleEntitySecret) {
      circleApiKey = hostedCircleApiKey;
      circleEntitySecret = hostedCircleEntitySecret;
    } else {
      credentialsUnreadable = HOSTED_NOT_CONFIGURED;
      warnings.push(HOSTED_NOT_CONFIGURED);
    }
  } else if (walletHost === "external") {
    // Its treasury is its owner's own wallet; the agent that pays through its contract lives in Vestiarion's agent
    // account (wallet treasury W4, W5). Its own credential columns are never opened.
    const profile = networkProfile(networkOf(org.network));
    const refused = !profile.walletTreasury ? new FeatureOffError("Paying from your own wallet", profile).message : !agentAccountReady ? WALLET_TREASURY_NOT_CONFIGURED : null;
    if (refused) {
      credentialsUnreadable = refused;
      warnings.push(refused);
    } else {
      circleApiKey = mainnetAgentCircleApiKey;
      circleEntitySecret = mainnetAgentCircleEntitySecret;
    }
  } else {
    circleApiKey = openCircleSecret("circle_api_key_enc");
    circleEntitySecret = openCircleSecret("circle_entity_secret_enc");
  }

  // Arc mainnet behind a switch (mainnet go-live M4). Off, a mainnet workspace gets no Circle credentials at all, as
  // network foundation N3 kept every one; on, its own credentials open, and its hold stands until it is live. It never
  // takes the platform's hosted testnet pair. One with no Circle account of its own has nothing here that could not be
  // read: `getChainProvider` refuses it, so it is never given the simulator (M5).
  const network = networkOf(org.network);
  const hold = networkHold(network, org.mode, base) ?? undefined;
  if (network === "arc-mainnet") {
    const withheld = !base.mainnetEnabled ? MAINNET_OFF : walletHost === "hosted" ? new FeatureOffError("A hosted wallet", ARC_MAINNET).message : null;
    if (withheld) {
      circleApiKey = undefined;
      circleEntitySecret = undefined;
      credentialsUnreadable = withheld;
      warnings.push(withheld);
    }
  }

  return {
    config: {
      ...base,
      businessName: org.name,
      network,
      chain: {
        ...platformChain,
        circleApiKey,
        circleEntitySecret,
        credentialsUnreadable,
        hostedAvailable,
        walletTreasuryAvailable: agentAccountReady,
        walletHost,
        // A live workspace whose owner turned the real reserve on (USYC live design R1).
        usycLive: org.mode === "live" && Boolean(org.usyc_live_at),
        networkHold: hold,
      },
      // A sandbox simulates its payments, so it screens against the bundled list, which costs nothing, and does so
      // every cycle; the screening service, metered per call, is for live workspaces, whose payments are real
      // (sandbox screening R1, R2). A live workspace never screens against the bundled list: on a deployment with no
      // service, its screening gives no verdict, and its counterparties stay unscreened (payment safety K1).
      compliance:
        org.mode === "live"
          ? base.compliance.openSanctionsUrl
            ? base.compliance
            : { ...base.compliance, serviceRequired: true }
          : base.compliance.openSanctionsUrl
            ? { ...base.compliance, openSanctionsUrl: undefined, openSanctionsApiKey: undefined, rescreenIntervalHours: 0 }
            : base.compliance,
      ledgerSigningKey: open("ledger_signing_key_enc"),
      ledgerPublicKey: undefined,
      // Public material. Every workspace's own rotations live on its row; the
      // founding organization additionally carries whatever the environment
      // still declares, from before a workspace kept its own retired keys.
      ledgerRetiredPublicKeys:
        org.id === FOUNDING_ORG_ID
          ? [base.ledgerRetiredPublicKeys, columnRetiredBundle].filter(Boolean).join("\n") || undefined
          : columnRetiredBundle,
      allowGeneratedLedgerKey: false,
    },
    warnings,
  };
}
