import type { VestiarionConfig } from "../config";
import { decryptSecret, type MasterKey, type SecretEnvelope } from "../secrets";

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
  wallet_host: "own" | "hosted" | null;
}

export const ORG_SECRET_COLUMNS =
  "id, slug, name, mode, ledger_signing_key_enc, circle_api_key_enc, circle_entity_secret_enc, wallet_host";

/** Why a hosted organization has no Circle credentials: this deployment lacks the hosted pair (H1, Review Focus 5). */
export const HOSTED_NOT_CONFIGURED = "the hosted Circle account is not configured on this deployment";

type SecretColumn = "ledger_signing_key_enc" | "circle_api_key_enc" | "circle_entity_secret_enc";

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
  let circleApiKey: string | undefined;
  let circleEntitySecret: string | undefined;
  if (org.wallet_host === "hosted") {
    // The hosted pair, whole or not at all. A hosted organization's own
    // credential columns are not opened: it pays from the platform's hosted
    // entity only, and switching to its own account clears the choice (H4).
    const { hostedCircleApiKey, hostedCircleEntitySecret } = base.chain;
    if (hostedCircleApiKey && hostedCircleEntitySecret) {
      circleApiKey = hostedCircleApiKey;
      circleEntitySecret = hostedCircleEntitySecret;
    } else {
      credentialsUnreadable = HOSTED_NOT_CONFIGURED;
      warnings.push(HOSTED_NOT_CONFIGURED);
    }
  } else {
    circleApiKey = openCircleSecret("circle_api_key_enc");
    circleEntitySecret = openCircleSecret("circle_entity_secret_enc");
  }

  return {
    config: {
      ...base,
      businessName: org.name,
      chain: {
        ...base.chain,
        circleApiKey,
        circleEntitySecret,
        credentialsUnreadable,
      },
      ledgerSigningKey: open("ledger_signing_key_enc"),
      ledgerPublicKey: undefined,
      // Public material, and only the founding chain has ever rotated.
      ledgerRetiredPublicKeys: org.id === FOUNDING_ORG_ID ? base.ledgerRetiredPublicKeys : undefined,
      allowGeneratedLedgerKey: false,
    },
    warnings,
  };
}
