/**
 * The example batch the payout batch check offers (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP11): made
 * up, in Safe's CSV Airdrop form with a name column after it, USDC on Base. It shows each kind of finding once: a pair
 * of addresses made to look alike, the same row twice, a name with two addresses, an address on OFAC's list, an invalid
 * checksum, the USDC contract as a receiver, an amount with 7 decimals, an amount 1,000 times the rest, and a token
 * contract made to look like USDC's; and two rows with nothing found. The listed address is one on the OFAC snapshot,
 * as the address checker's tests use; USDC's contract is Base's own; every other address is made up and owned by no
 * one the page knows.
 */

/** The name the example shows under, wherever it shows. */
export const SAMPLE_PAYOUT_SOURCE = "Example payout batch (made-up payees)";

/** The name "Download the example" saves it under. */
export const SAMPLE_PAYOUT_FILE = "example-payout-batch.csv";

/** USDC's contract on Base. */
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Made up, with USDC on Base's first 4 and last 4 digits. */
const FAKE_USDC = "0x833522497C4013027398e6351d9beA7058412913";
/** Made up, checksummed. */
const JUNIPER = "0x788E65A0eBb472f4331Bf485b47CA5472Ab783Bf";
/**
 * Juniper's address with its last letter's case changed, so its checksum no longer matches. Changed here rather than
 * written so: every mixed-case address written in the code is checksummed (tests/address-checksums.test.ts).
 */
const JUNIPER_MISTYPED = `${JUNIPER.slice(0, -1)}${JUNIPER.slice(-1).toUpperCase()}`;

/** The example as a CSV. */
export function samplePayoutBatch(): string {
  const row = (receiver: string, amount: string, name: string, token = USDC_ON_BASE) => `erc20,${token},${receiver},${amount},,${name}`;
  return [
    "token_type,token_address,receiver,amount,id,name",
    row("0x7a2Dc41E9b03F6a85D1C27E4b98F0A3C61d5e10d", "1200", "Northwind Design"),
    row("0x562AcEDfA970Dc60f109F21C66507B752413f4Fb", "350", "Harbor Print Co"),
    row("0x59Bd40189E7f95B34975ecf4cf3DA46bA8481133", "86.5", "Cedar Coffee Roasters"),
    // On OFAC's SDN list.
    row("0x0330070FD38Ec3bB94F58FA55D40368271E9e54A", "400", "Kestrel Data Ltd"),
    // Northwind Design's first 4 and last 4 digits.
    row("0x7a2D8F06c3e1b9a457d02C6e8f1B3A9d4e7cE10d", "980", "Orchid Studio"),
    row("0x59Bd40189E7f95B34975ecf4cf3DA46bA8481133", "86.5", "Cedar Coffee Roasters"),
    // Its last letter's case changed: the checksum no longer matches.
    row(JUNIPER_MISTYPED, "412", "Juniper Office Supply"),
    row(USDC_ON_BASE, "450", "Maple Street Cleaning"),
    row("0x9B0CB8709c006B11475Dd0ea18885Dd78ba7c7ad", "1800.0000001", "Redwood Legal"),
    row("0xe64d68Bd5961E6dc60e297329cD586F0eB2625DE", "400000", "Bluebell Print Co"),
    row("0x567bdfC5C89343Ffd538025bab9Cf9f7f13D5a71", "120", "Harbor Print Co"),
    row("0x3649A5D7bd1F20F487B5fd64fc520A112e4E3337", "300", "Pinewood Events", FAKE_USDC),
    row("0x56E88F36Fa7f1550ac92491Bc047C82b756bdF50", "240", "Riverbank Bakery"),
    row("0xBf8226cCCBD001a8ecF62A0f14bC7Bdf248Bf43f", "960", "Lakeside Freight"),
  ].join("\n");
}
