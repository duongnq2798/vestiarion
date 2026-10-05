import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Whether an address's mix of capital and small letters matches its EIP-55 checksum (payment safety A1,
 * docs/superpowers/specs/2026-10-05-payment-safety-design.md). An address written in one case alone carries no
 * checksum, and is taken as written. A mismatch means a character was most likely mistyped, and a payment to it would
 * reach no one: real money is gone. Pure, so the console's forms and the API check it alike.
 */
export function checksumMatches(address: string): boolean {
  const body = address.replace(/^0x/, "");
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = bytesToHex(keccak_256(body.toLowerCase()));
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (!/[a-fA-F]/.test(char)) continue;
    const upper = Number.parseInt(hash[i], 16) >= 8;
    if ((char === char.toUpperCase()) !== upper) return false;
  }
  return true;
}

/** What is said of an address whose capital letters do not match its checksum. */
export const CHECKSUM_MISMATCH = "This address's capital letters do not match its checksum, so a character is likely wrong.";

/** An Arc (EVM) address: 0x and 40 hex characters. */
export const ARC_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const NOT_AN_ARC_ADDRESS = "Enter an Arc address: 0x followed by 40 hex characters.";

/**
 * Why an address a person typed cannot be paid, or null when it can (payment safety A1): not an Arc address, or one
 * whose capital letters do not match its checksum. Pure, for the console's forms on either side.
 */
export function addressProblem(value: string): string | null {
  if (!ARC_ADDRESS.test(value)) return NOT_AN_ARC_ADDRESS;
  return checksumMatches(value) ? null : `${CHECKSUM_MISMATCH} Copy it again from where it came.`;
}
