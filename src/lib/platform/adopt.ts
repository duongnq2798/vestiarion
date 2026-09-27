import crypto from "node:crypto";
import { ledgerKeyId } from "../ledger-keys";
import { encryptSecret, type MasterKey, type SecretEnvelope } from "../secrets";

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
 */
export function adoptEnvSecrets(input: {
  orgId: string;
  env: Record<string, string | undefined>;
  keys: MasterKey[];
  expectLedgerKeyId: string;
}): AdoptedSecrets {
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
