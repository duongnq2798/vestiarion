import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { EXAMPLE_KNOWN, EXAMPLE_PAY } from "@/components/address-check/AddressChecker";
import { chanceWords, checkAddress, knownAddresses, madeToLookAlike, sharedEnds, specialAddress } from "@/lib/address-check";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import { looksAlike } from "@/lib/payee-lock-rules";

/**
 * The address lookalike checker's rules (docs/superpowers/specs/2026-10-21-address-checker-design.md AC1-AC5): the
 * form of what was pasted, its checksum, addresses made to look like known ones, OFAC's list and addresses no payee
 * should give.
 */

const KNOWN = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
const known = [{ label: "Northwind", address: KNOWN }];
const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const check = (raw: string, list = known) => checkAddress(raw, list, sanctioned);
/** KNOWN with its middle replaced, keeping `leading` digits at the start and `trailing` at the end. */
const alike = (leading: number, trailing: number) => {
  const digits = KNOWN.slice(2);
  const middle = [...digits.slice(leading, 40 - trailing)].map((digit) => (digit === "9" ? "8" : "9")).join("");
  return `0x${digits.slice(0, leading)}${middle}${digits.slice(40 - trailing)}`;
};

describe("what was pasted (AC1)", () => {
  it("says what is wrong with something that is not an address yet, and checks nothing else", () => {
    expect(check("  ").format).toMatchObject({ ok: false, problem: "empty" });
    expect(check(KNOWN.slice(0, 41)).format).toMatchObject({ ok: false, problem: "length", message: expect.stringContaining("It has 39 characters after 0x") });
    expect(check(`${KNOWN}0`).format).toMatchObject({ ok: false, problem: "length" });
    expect(check(KNOWN.slice(2)).format).toMatchObject({ ok: false, problem: "no_prefix", message: expect.stringContaining("without it") });
    expect(check(`0x${"g".repeat(40)}`).format).toMatchObject({ ok: false, problem: "not_hex", message: expect.stringContaining("Character 3, “g”") });
    expect(check(`${KNOWN.slice(0, 10)} ${KNOWN.slice(10)}`).format).toMatchObject({ ok: false, problem: "not_hex" });
    const result = check(KNOWN.slice(0, 41));
    expect(result).toMatchObject({ verdict: "fix", address: null, matches: [], sanctioned: null, special: null });
  });

  it("finds characters nobody sees, which a copy can carry", () => {
    for (const hidden of ["​", "‍", "‮", "⁦", "﻿"]) {
      const result = check(`${KNOWN.slice(0, 20)}${hidden}${KNOWN.slice(20)}`);
      expect(result.format, hidden.codePointAt(0)!.toString(16)).toMatchObject({ ok: false, problem: "invisible" });
    }
    expect(check(`${KNOWN.slice(0, 20)}‮${KNOWN.slice(20)}`).format).toMatchObject({ message: expect.stringContaining("U+202E") });
  });

  it("finds letters from other scripts, full-width digits and O, l or I standing in for 0 or 1", () => {
    expect(check(`0x7а${KNOWN.slice(4)}`).format).toMatchObject({ problem: "lookalike_character", message: expect.stringContaining("Character 4, “а” (U+0430), only looks like “a”") });
    expect(check(`0х${KNOWN.slice(2)}`).format).toMatchObject({ problem: "lookalike_character" });
    expect(check(`0x７${KNOWN.slice(3)}`).format).toMatchObject({ problem: "lookalike_character", message: expect.stringContaining("only looks like “7”") });
    expect(check(`0x${KNOWN.slice(2, 10)}O${KNOWN.slice(11)}`).format).toMatchObject({ problem: "lookalike_character", message: expect.stringContaining("only looks like “0”") });
    expect(check(`0x${KNOWN.slice(2, 10)}l${KNOWN.slice(11)}`).format).toMatchObject({ problem: "lookalike_character" });
  });

  it("takes an address with spaces around it, and 0X, as an address", () => {
    expect(check(`  ${KNOWN}\n`).address).toBe(KNOWN);
    expect(check(`0X${KNOWN.slice(2)}`).address).toBe(KNOWN);
  });
});

describe("the checksum (AC2)", () => {
  const checksummed = getAddress(KNOWN);

  it("passes a mixed-case address that matches EIP-55, and says a single-case one carries none", () => {
    expect(check(checksummed)).toMatchObject({ checksum: "valid", checksummed, verdict: "same" });
    expect(check(KNOWN)).toMatchObject({ checksum: "none", checksummed });
    expect(check(KNOWN.toUpperCase().replace("0X", "0x"))).toMatchObject({ checksum: "none" });
  });

  it("stops at one whose mix of capitals does not match: typed wrong or changed", () => {
    const index = [...checksummed].findIndex((character, position) => position > 1 && /[a-f]/i.test(character));
    const flipped = checksummed.slice(0, index) + (checksummed[index] === checksummed[index].toUpperCase() ? checksummed[index].toLowerCase() : checksummed[index].toUpperCase()) + checksummed.slice(index + 1);
    expect(check(flipped, [])).toMatchObject({ checksum: "invalid", verdict: "stop" });
  });
});

describe("addresses made to look like known ones (AC3)", () => {
  it("counts the digits two addresses share at each end", () => {
    expect(sharedEnds(KNOWN, alike(4, 4))).toEqual({ leading: 4, trailing: 4 });
    expect(sharedEnds(KNOWN, KNOWN)).toEqual({ leading: 40, trailing: 40 });
    expect(sharedEnds(KNOWN.toUpperCase().replace("0X", "0x"), KNOWN)).toEqual({ leading: 40, trailing: 40 });
  });

  it("calls an address made to look alike at 3 digits at each end, or 5 at one, and stops at it", () => {
    for (const [leading, trailing] of [[4, 4], [3, 3], [6, 4], [0, 5], [5, 0]] as const) {
      const result = check(alike(leading, trailing));
      expect(result.verdict, `${leading}+${trailing}`).toBe("stop");
      expect(result.matches, `${leading}+${trailing}`).toEqual([{ known: known[0], kind: "alike", leading, trailing }]);
    }
    for (const [leading, trailing] of [[2, 2], [3, 2], [4, 0], [0, 4]] as const) {
      expect(check(alike(leading, trailing)), `${leading}+${trailing}`).toMatchObject({ verdict: "check", matches: [] });
    }
  });

  it("says the very address is the one known, and puts lookalikes first, most digits shared first", () => {
    expect(check(KNOWN)).toMatchObject({ verdict: "same", matches: [{ kind: "same", known: known[0] }] });
    const list = [
      { label: "Same", address: alike(4, 4) },
      { label: "Three", address: alike(3, 3) },
      { label: "Six", address: alike(6, 4) },
    ];
    const result = check(alike(4, 4), list);
    expect(result.matches.map((match) => [match.known.label, match.kind])).toEqual([
      ["Six", "alike"],
      ["Three", "alike"],
      ["Same", "same"],
    ]);
    expect(result.verdict).toBe("stop");
  });

  it("catches every pair the payee lock's warning catches (PL6: first 6 and last 4)", () => {
    let seed = 7;
    const hex = (length: number) =>
      Array.from({ length }, () => {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        return (seed % 16).toString(16);
      }).join("");
    for (let index = 0; index < 200; index += 1) {
      const start = hex(6);
      const end = hex(4);
      const a = `0x${start}${hex(30)}${end}`;
      const b = `0x${start}${hex(30)}${end}`;
      if (looksAlike(a, b)) expect(madeToLookAlike(sharedEnds(a, b)), `${a} ${b}`).toBe(true);
    }
  });

  it("puts how rare a match is in words", () => {
    expect(chanceWords(8)).toBe("1 in 4.3 billion");
    expect(chanceWords(6)).toBe("1 in 17 million");
    expect(chanceWords(10)).toBe("1 in 1.1 trillion");
    expect(chanceWords(4)).toBe("1 in 66 thousand");
    expect(chanceWords(2)).toBe("1 in 256");
  });

  it("has an example whose address shares Northwind's first 4 and last 4 digits", () => {
    const list = knownAddresses(EXAMPLE_KNOWN);
    const result = check(EXAMPLE_PAY, list);
    expect(result.verdict).toBe("stop");
    expect(result.matches).toEqual([{ known: list[0], kind: "alike", leading: 4, trailing: 4 }]);
    expect(list.map((entry) => entry.label)).toEqual(["Northwind Design", "Harbor Print Co"]);
  });
});

describe("OFAC's list and addresses that are not a wallet (AC4)", () => {
  it("stops at an address on the SDN list, naming its entry", () => {
    const [listed] = snapshot.wallets;
    expect(check(listed.address.toUpperCase().replace("0X", "0x"), [])).toMatchObject({ verdict: "stop", sanctioned: { address: listed.address, name: listed.name } });
    expect(check(KNOWN, []).sanctioned).toBeNull();
  });

  it("stops at the zero and burn addresses, USDC and EURC contracts, and Arc's USDC system address", () => {
    expect(specialAddress(`0x${"0".repeat(40)}`)).toEqual({ kind: "zero" });
    expect(specialAddress("0x000000000000000000000000000000000000dEaD")).toEqual({ kind: "burn" });
    expect(specialAddress("0x3600000000000000000000000000000000000000")).toEqual({ kind: "token", label: "USDC on Arc" });
    expect(specialAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")).toEqual({ kind: "token", label: "USDC on Base" });
    expect(specialAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")).toEqual({ kind: "token", label: "USDC on Ethereum" });
    expect(specialAddress("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1")).toEqual({ kind: "token", label: "EURC on Arc mainnet" });
    expect(specialAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e")).toEqual({ kind: "token", label: "USDC on Base Sepolia" });
    expect(specialAddress("0xfffffffffffffffffffffffffffffffffffffffe")).toEqual({ kind: "system" });
    expect(check("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", [])).toMatchObject({ verdict: "stop", special: { kind: "token" } });
    expect(specialAddress(KNOWN)).toBeNull();
  });

  it("says nothing is wrong, but nothing says whose it is, about an address that passes everything", () => {
    expect(check(alike(0, 0), known)).toMatchObject({ verdict: "check", matches: [], sanctioned: null, special: null, checksum: "none" });
  });
});

describe("the addresses someone knows (AC5)", () => {
  it("reads one or more a line, the rest of the line as the name, each address once, at most 200", () => {
    const b = alike(0, 0);
    expect(knownAddresses(`Northwind Design, ${KNOWN}\n${b}\n  - Harbor: ${KNOWN.toUpperCase().replace("0X", "0x")}\nnothing here\nTwo ${b} ${alike(1, 1)}`)).toEqual([
      { label: "Northwind Design", address: KNOWN },
      { label: "Address 2", address: b },
      { label: "Two", address: alike(1, 1) },
    ]);
    const many = Array.from({ length: 250 }, (_, index) => `0x${index.toString(16).padStart(40, "0")}`).join("\n");
    expect(knownAddresses(many)).toHaveLength(200);
  });

  it("does not read a transaction hash, or longer hex, as an address", () => {
    expect(knownAddresses(`Paid in tx 0x${"ab".repeat(32)}`)).toEqual([]);
    expect(knownAddresses(`x0x${KNOWN.slice(2)}`)).toEqual([]);
  });
});
