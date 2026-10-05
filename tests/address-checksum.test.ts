import { describe, expect, it } from "vitest";
import { addressProblem, checksumMatches } from "@/lib/address-checksum";

/**
 * EIP-55 checksums (payment safety A1, docs/superpowers/specs/2026-10-05-payment-safety-design.md): the examples the
 * EIP itself lists pass, the same addresses with one letter's case flipped fail, and an address in one case alone is
 * taken as written.
 */

const EIP55 = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

const flipFirstLetter = (address: string) =>
  address.replace(/[a-fA-F]/, (char) => (char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()));

describe("checksumMatches", () => {
  it("passes the EIP's own examples", () => {
    for (const address of EIP55) expect(checksumMatches(address), address).toBe(true);
  });

  it("fails each of them with one letter's case flipped", () => {
    for (const address of EIP55) expect(checksumMatches(flipFirstLetter(address)), address).toBe(false);
  });

  it("takes an address in one case alone as written", () => {
    for (const address of EIP55) {
      expect(checksumMatches(address.toLowerCase())).toBe(true);
      expect(checksumMatches(`0x${address.slice(2).toUpperCase()}`)).toBe(true);
    }
  });
});

describe("addressProblem", () => {
  it("names what is wrong, or nothing", () => {
    expect(addressProblem(EIP55[0])).toBeNull();
    expect(addressProblem("0x1234")).toBe("Enter an Arc address: 0x followed by 40 hex characters.");
    expect(addressProblem(flipFirstLetter(EIP55[0]))).toMatch(/^This address's capital letters do not match its checksum/);
  });
});
