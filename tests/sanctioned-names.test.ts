import { describe, expect, it } from "vitest";
import names from "@/lib/data/ofac-sdn-names.json";
import wallets from "@/lib/data/ofac-sdn-evm-wallets.json";
import { parseSdnNames, type SdnNameEntry, type SdnNameSnapshot } from "@/lib/sanctioned-wallets";

/**
 * The SDN name snapshot (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV1): each entry of OFAC's SDN list
 * with its type, programs, other names, countries and digital-currency addresses, read from SDN.CSV, SDN_COMMENTS.CSV,
 * ALT.CSV and ADD.CSV, and the dated snapshot the vendor check loads.
 */

const EMPTY = "-0- ";
/** An SDN.CSV row: number, name, type, programs, then seven columns this check ignores, then the remarks. */
const sdnRow = (number: number, name: string, type: string, programs: string, remarks: string) =>
  [number, `"${name}"`, type === "" ? EMPTY : `"${type}"`, `"${programs}"`, ...Array(7).fill(EMPTY), remarks === "" ? EMPTY : `"${remarks}"`].join(",");
const altRow = (number: number, alt: number, kind: string, name: string) => `${number},${alt},"${kind}","${name}",${EMPTY}`;
const addRow = (number: number, add: number, country: string) => `${number},${add},${EMPTY},${EMPTY},${country === "" ? EMPTY : `"${country}"`},${EMPTY}`;
/** OFAC's files end with this character, after the last line. */
const END = String.fromCharCode(26);

const snapshot = names as unknown as SdnNameSnapshot;
const entry = (number: number) => snapshot.entries.find((each) => each[0] === number);

describe("parseSdnNames (CV1)", () => {
  const files = {
    sdn: [
      sdnRow(306, "BANCO NACIONAL DE CUBA", "", "CUBA", "a.k.a. 'BNC'."),
      sdnRow(2676, "AL ZAWAHIRI, Dr. Ayman", "individual", "SDGT", "DOB 19 Jun 1951; POB Giza, Egypt; nationality Egypt; alt. Citizen Sudan."),
      sdnRow(9001, "SEA STAR", "vessel", "IRAN] [IFSR", "Vessel Registration Identification IMO 9000001; Nationality of Registration Panama."),
      sdnRow(27307, "LAZARUS GROUP", "", "DPRK3", "Digital Currency Address - ETH 0x098B716B8Aaf21512996dC57EB0615e2383E2f96; Digital Currency Address - XBT 1Boat"),
      `${END}`,
    ].join("\r\n"),
    comments: `27307,"SLRHtKNngkdXEeobR76b53LETtpyT; Digital Currency Address - ETH 0x098B716B8Aaf21512996dC57EB0615e2383E2f96."\r\n${END}`,
    alt: [
      altRow(306, 220, "aka", "NATIONAL BANK OF CUBA"),
      altRow(2676, 4760, "aka", "AL-ZAWAHIRI, Ayman"),
      altRow(2676, 4761, "fka", "SALIM, Ahmad Fuad"),
      altRow(2676, 4762, "aka", "AL-ZAWAHIRI, Ayman"),
      altRow(2676, 4763, "aka", "AL ZAWAHIRI, Dr. Ayman"),
      altRow(99999, 1, "aka", "NOT AN ENTRY"),
      END,
    ].join("\r\n"),
    add: [addRow(306, 199, "Switzerland"), addRow(306, 200, "Spain"), addRow(306, 201, "Spain"), addRow(9001, 5, ""), addRow(27307, 9, "Region: Korea, North"), END].join("\r\n"),
  };
  const parsed = parseSdnNames(files);

  it("reads each entry once, in number order, with its type and programs", () => {
    expect(parsed.map((each) => each[0])).toEqual([306, 2676, 9001, 27307]);
    expect(parsed[0].slice(0, 4)).toEqual([306, "BANCO NACIONAL DE CUBA", "entity", ["CUBA"]]);
    expect(parsed[1][2]).toBe("individual");
    expect(parsed[2].slice(2, 4)).toEqual(["vessel", ["IRAN", "IFSR"]]);
  });

  it("takes other names from ALT.CSV, each once and never the name itself, and leaves weak a.k.a.s in remarks out", () => {
    expect(parsed[0][4]).toEqual(["NATIONAL BANK OF CUBA"]);
    expect(parsed[1][4]).toEqual(["AL-ZAWAHIRI, Ayman", "SALIM, Ahmad Fuad"]);
    expect(parsed[0][4]).not.toContain("BNC");
  });

  it("takes countries from addresses and from nationality and citizenship, sorted, but not a vessel's flag", () => {
    expect(parsed[0][5]).toEqual(["Spain", "Switzerland"]);
    expect(parsed[1][5]).toEqual(["Egypt", "Sudan"]);
    expect(parsed[2][5]).toEqual([]);
    expect(parsed[3][5]).toEqual(["Korea, North"]);
  });

  it("lists digital-currency addresses of any currency, as written, once each, across both remarks files", () => {
    expect(parsed[3][6]).toEqual(["ETH 0x098B716B8Aaf21512996dC57EB0615e2383E2f96", "XBT 1BoatSLRHtKNngkdXEeobR76b53LETtpyT"]);
    expect(parsed[0][6]).toEqual([]);
  });
});

describe("the snapshot (CV1)", () => {
  it("is dated, ordered by number with each entry once, and shaped as the matcher reads it", () => {
    expect(snapshot.source).toBe("OFAC SDN list");
    expect(Number.isNaN(Date.parse(snapshot.readAt))).toBe(false);
    const numbers = snapshot.entries.map((each) => each[0]);
    expect(numbers.every((number, at) => at === 0 || number > numbers[at - 1])).toBe(true);
    expect(snapshot.entries.length).toBeGreaterThan(15_000);
    // One expectation over all 19,000-odd entries, so the test stays fast: the entries that break a rule, by number.
    const misshapen = (snapshot.entries as SdnNameEntry[]).filter((each) => {
      const [number, name, type, programs, otherNames, countries, addresses] = each;
      return (
        each.length !== 7 ||
        !Number.isInteger(number) ||
        name === "" ||
        name.trim() !== name ||
        !["entity", "individual", "vessel", "aircraft"].includes(type) ||
        programs.length === 0 ||
        otherNames.includes(name) ||
        new Set(otherNames).size !== otherNames.length ||
        countries.some((country, at) => at > 0 && country <= countries[at - 1]) ||
        addresses.some((address) => !/^[A-Z0-9]+ [A-Za-z0-9]+$/.test(address))
      );
    });
    expect(misshapen.map((each) => each[0])).toEqual([]);
  });

  it("carries the same day and the same EVM addresses as the wallet snapshot, read from the same download", () => {
    expect(snapshot.readAt).toBe(wallets.readAt);
    const evm = new Set(
      snapshot.entries.flatMap((each) => each[6].map((address) => address.split(" ")[1]).filter((address) => /^0x[0-9a-fA-F]{40}$/.test(address)).map((address) => address.toLowerCase()))
    );
    expect([...evm].sort()).toEqual(wallets.wallets.map((wallet) => wallet.address));
  });

  it("holds real entries with their other names, programs and countries", () => {
    expect(entry(306)).toEqual([306, "BANCO NACIONAL DE CUBA", "entity", ["CUBA"], ["NATIONAL BANK OF CUBA"], ["Japan", "Panama", "Spain", "Switzerland"], []]);
    expect(entry(25578)?.slice(0, 5)).toEqual([25578, "BANK MELLI IRAN", "entity", ["IRAN", "SDGT", "IFSR"], ["BANK MELLI", "MELLI BANK", "NATIONAL BANK OF IRAN"]]);
    expect(entry(27307)?.[6].length).toBeGreaterThan(0);
  });

  it("stays well under 3 MB, since the browser loads it to check a name", async () => {
    const { statSync } = await import("node:fs");
    const bytes = statSync("src/lib/data/ofac-sdn-names.json").size;
    expect(bytes).toBeLessThan(2_600_000);
  });
});
