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
}

export const ORG_SECRET_COLUMNS =
  "id, slug, name, mode, ledger_signing_key_enc, circle_api_key_enc, circle_entity_secret_enc";

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
  const circleApiKey = openCircleSecret("circle_api_key_enc");
  const circleEntitySecret = openCircleSecret("circle_entity_secret_enc");

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
