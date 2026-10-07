import type { WalletHost } from "../config";
import crypto from "node:crypto";
import { ledgerKeyId } from "../ledger-keys";
import { decryptSecret, encryptSecret, type MasterKey, type SecretEnvelope } from "../secrets";

export interface AdoptedSecrets {
  ledger_signing_key_enc: SecretEnvelope;
  circle_api_key_enc: SecretEnvelope | null;
  circle_entity_secret_enc: SecretEnvelope | null;
  ledgerKeyId: string;
}

/**
 * Moves an organization's secrets from the platform's environment into its own
 * row, encrypted. Refuses a ledger key that is not the one that signed the
 * chain: storing the wrong key would make every future entry unverifiable
 * against the history, which is the failure the key-custody work exists to
 * prevent.
 *
 * Refuses a hosted workspace (hosted wallets H1): its Circle credentials are
 * the platform's hosted pair, given by `orgConfig`, and its wallets live in
 * that entity. Credentials adopted from this environment would be ignored
 * while it is hosted, and would point it at another entity if it ever were not.
 */
export function adoptEnvSecrets(input: {
  orgId: string;
  env: Record<string, string | undefined>;
  keys: MasterKey[];
  expectLedgerKeyId: string;
  /** The organization's `wallet_host`, as its row says now. */
  walletHost: WalletHost | null;
}): AdoptedSecrets {
  if (input.walletHost === "hosted") {
    throw new Error(
      "This workspace uses a hosted testnet wallet (wallet_host = 'hosted'); refusing to adopt this environment's secrets into it"
    );
  }
  const raw = input.env.LEDGER_SIGNING_KEY;
  if (!raw) throw new Error("LEDGER_SIGNING_KEY is not set; there is no ledger key to adopt");
  const pem = raw.split("\\n").join("\n");
  const id = ledgerKeyId(crypto.createPrivateKey(pem));
  if (id !== input.expectLedgerKeyId) {
    throw new Error(
      `LEDGER_SIGNING_KEY is key ${id}, but ${input.expectLedgerKeyId} signed this chain; refusing to store it`
    );
  }

  const seal = (value: string | undefined, column: string): SecretEnvelope | null =>
    value ? encryptSecret(value, { orgId: input.orgId, column }, input.keys) : null;

  return {
    ledger_signing_key_enc: encryptSecret(pem, { orgId: input.orgId, column: "ledger_signing_key_enc" }, input.keys),
    circle_api_key_enc: seal(input.env.CIRCLE_API_KEY, "circle_api_key_enc"),
    circle_entity_secret_enc: seal(input.env.CIRCLE_ENTITY_SECRET, "circle_entity_secret_enc"),
    ledgerKeyId: id,
  };
}

/**
 * Whether adopting the environment's ledger key `envKeyId` would undo a
 * rotation, as a message to print, or `null` when it may go ahead. Decided
 * from the organization's row alone, before anything is written.
 *
 * - A key the workspace has retired can never sign for it again: its private
 *   half was discarded on purpose, and adopting a copy of it back would put
 *   the old authority back in charge.
 * - A workspace that already signs with a readable key of its own keeps it:
 *   replacing it would discard the private half of whatever signed the recent
 *   entries. Rotation, from Settings, is the one way to change the key.
 *
 * Re-adopting the key already stored is allowed, so the command stays
 * idempotent. A stored key that cannot be opened is not "a key this workspace
 * signs with", so it does not refuse; `--expect-key-id` still guards the
 * adoption. No refusal names anything but key ids and a time.
 */
export function ledgerKeyAdoptionRefusal(input: {
  orgId: string;
  row: { ledger_signing_key_enc: SecretEnvelope | null; ledger_retired_keys: unknown };
  envKeyId: string;
  keys: MasterKey[];
}): string | null {
  const retired = (Array.isArray(input.row.ledger_retired_keys) ? input.row.ledger_retired_keys : []).find(
    (item): item is { id: string; retiredAt?: unknown } =>
      typeof item === "object" && item !== null && (item as { id?: unknown }).id === input.envKeyId
  );
  if (retired) {
    const when = typeof retired.retiredAt === "string" ? retired.retiredAt : "an earlier date";
    return `That key was retired on ${when}; it can no longer sign for this workspace. Rotate from Settings → Ledger signing key instead.`;
  }

  const stored = storedLedgerKeyId(input.orgId, input.row.ledger_signing_key_enc, input.keys);
  if (stored && stored !== input.envKeyId) {
    return `This workspace already signs with key ${stored}; adopting ${input.envKeyId} would replace it. Rotate from Settings → Ledger signing key instead.`;
  }
  return null;
}

/** The id of the key stored on the row, or `null` when there is none or it cannot be opened. The reason is not kept. */
function storedLedgerKeyId(orgId: string, envelope: SecretEnvelope | null, keys: MasterKey[]): string | null {
  if (!envelope) return null;
  try {
    return ledgerKeyId(crypto.createPrivateKey(decryptSecret(envelope, { orgId, column: "ledger_signing_key_enc" }, keys)));
  } catch {
    return null;
  }
}
