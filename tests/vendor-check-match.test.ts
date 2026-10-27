import { beforeAll, describe, expect, it } from "vitest";
import names from "@/lib/data/ofac-sdn-names.json";
import type { SdnNameSnapshot } from "@/lib/sanctioned-wallets";
import { STRONG_SANCTIONS_MATCH_THRESHOLD } from "@/lib/screening/providers";
import {
  buildNameIndex,
  countryAgreement,
  jaroWinkler,
  MATCHES_SHOWN,
  matchName,
  nameWords,
  POSSIBLE_MATCH,
  soundKey,
  STRONG_MATCH,
  wordCloseness,
  type NameIndex,
  type NameMatch,
} from "@/lib/vendor-check/match";

/**
 * The vendor check's name matcher (docs/superpowers/specs/2026-10-28-check-vendor-design.md CV2-CV5): names as
 * compared, two words as compared, a name's score against every SDN entry, the bands, and the country. Run on the real
 * snapshot, with real entries: their names, other names, other spellings, and ordinary business names that must not
 * find a strong match.
 */

let index: NameIndex;
beforeAll(() => {
  index = buildNameIndex(names as unknown as SdnNameSnapshot);
});

const top = (name: string, country?: string) => matchName(index, name, country)[0];
const numbers = (matches: NameMatch[]) => matches.map((match) => match.entry.number);

describe("nameWords (CV2)", () => {
  it("drops accents, case, dots and apostrophes, and splits on other punctuation", () => {
    expect(nameWords("Banco Nacional de Cuba S.A.")).toEqual(["banco", "nacional", "de", "cuba"]);
    expect(nameWords("AL-QA'IDA")).toEqual(["al", "qaida"]);
    expect(nameWords("Société Générale")).toEqual(["societe", "generale"]);
    expect(nameWords("Smith & Sons, LLC")).toEqual(["smith", "and", "sons"]);
  });

  it("drops legal forms, short and long, wherever they stand, unless the name is nothing else", () => {
    expect(nameWords("Northwind Design Ltd")).toEqual(["northwind", "design"]);
    expect(nameWords("OOO Sberbank Kapital")).toEqual(["sberbank", "kapital"]);
    expect(nameWords("PUBLIC JOINT STOCK COMPANY SBERBANK OF RUSSIA")).toEqual(["sberbank", "of", "russia"]);
    expect(nameWords("LIMITED LIABILITY COMPANY SBERBANK CAPITAL")).toEqual(["sberbank", "capital"]);
    expect(nameWords("OBSHCHESTVO S OGRANICHENNOI OTVETSTVENNOSTYU SBERBANK KAPITAL")).toEqual(["sberbank", "kapital"]);
    expect(nameWords("Harbor Print Co., Ltd.")).toEqual(["harbor", "print"]);
    expect(nameWords("Acme GmbH & Co. KG")).toEqual(["acme", "and"]);
    expect(nameWords("Co., Ltd.")).toEqual(["co", "ltd"]);
    expect(nameWords("  ")).toEqual([]);
  });
});

describe("two words (CV3)", () => {
  it("scores Jaro-Winkler as its authors' examples do", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.961, 3);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 3);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.813, 3);
    expect(jaroWinkler("same", "same")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
  });

  it("runs vowels and doubled letters together for the sound key", () => {
    expect(soundKey("hezbollah")).toBe(soundKey("hizballah"));
    expect(soundKey("osama")).toBe(soundKey("usama"));
    expect(soundKey("mohamed")).toBe(soundKey("muhammad"));
    expect(soundKey("ayman")).toBe(soundKey("aiman"));
    expect(soundKey("bank")).not.toBe(soundKey("bunker"));
  });

  it("says how close two words are: the same, spelled another way, close, or not at all", () => {
    expect(wordCloseness("melli", "melli")).toEqual({ closeness: 1, how: "same" });
    expect(wordCloseness("hezbollah", "hizballah")).toEqual({ closeness: 0.9, how: "alike" });
    const close = wordCloseness("kadhafi", "qadhafi");
    expect(close?.how).toBe("close");
    expect(close!.closeness).toBeGreaterThanOrEqual(0.5);
    expect(close!.closeness).toBeLessThan(0.9);
    // Short words count only when they are the same, and a shared sound key alone is not enough.
    expect(wordCloseness("ali", "aly")).toBeNull();
    expect(wordCloseness("maria", "meru")).toBeNull();
    expect(wordCloseness("bank", "pizza")).toBeNull();
  });
});

describe("a name against the list (CV4)", () => {
  it("uses the product's strong threshold, and yente's cut-off below it", () => {
    expect(STRONG_MATCH).toBe(STRONG_SANCTIONS_MATCH_THRESHOLD);
    expect(POSSIBLE_MATCH).toBe(0.7);
    expect(MATCHES_SHOWN).toBe(3);
  });

  it("finds an entry by its own name, legal forms and word order aside", () => {
    const melli = top("Bank Melli Iran");
    expect(melli).toMatchObject({ band: "strong", score: 1, via: "name", matched: "BANK MELLI IRAN" });
    expect(melli.entry).toMatchObject({ number: 25578, type: "entity", programs: ["IRAN", "SDGT", "IFSR"] });
    expect(melli.pairs).toEqual([
      { typed: "bank", listed: "bank", how: "same" },
      { typed: "melli", listed: "melli", how: "same" },
      { typed: "iran", listed: "iran", how: "same" },
    ]);
    expect(top("Banco Nacional de Cuba S.A.")).toMatchObject({ band: "strong", score: 1, via: "name", entry: { number: 306 } });
    expect(numbers(matchName(index, "Ayman al-Zawahiri"))).toContain(2676);
    expect(top("Ayman al-Zawahiri")).toMatchObject({ band: "strong", via: "other_name", matched: "AL-ZAWAHIRI, Ayman" });
  });

  it("finds an entry by one of its other names", () => {
    expect(top("National Bank of Cuba")).toMatchObject({ band: "strong", via: "other_name", matched: "NATIONAL BANK OF CUBA", entry: { number: 306, name: "BANCO NACIONAL DE CUBA" } });
    expect(numbers(matchName(index, "Sberbank of Russia PJSC"))).toContain(17018);
    expect(top("Wagner Group")).toMatchObject({ band: "strong", entry: { number: 22543 } });
  });

  it("finds other spellings and spacing, and says how each word paired", () => {
    const hezbollah = top("Hezbollah");
    expect(hezbollah).toMatchObject({ band: "strong", entry: { number: 4697, name: "HIZBALLAH" } });
    expect(hezbollah.pairs).toEqual([{ typed: "hezbollah", listed: "hizballah", how: "alike" }]);
    const gaddafi = top("Moammar Kadhafi");
    expect(gaddafi).toMatchObject({ band: "possible", entry: { number: 12606 } });
    expect(gaddafi.pairs.map((pair) => pair.how).sort()).toEqual(["alike", "close"]);
    expect(top("Alqaida")).toMatchObject({ band: "strong", spacing: true, entry: { number: 6366 } });
  });

  it("calls a match on some words of a longer name possible, and says which words had no pair", () => {
    const star = top("Golden Star Logistics");
    expect(star).toMatchObject({ band: "possible", entry: { number: 24752, name: "GOLDEN STAR CO" } });
    expect(star.typedOnly).toEqual(["logistics"]);
    expect(star.listedOnly).toEqual([]);
    expect(star.score).toBeGreaterThanOrEqual(POSSIBLE_MATCH);
    expect(star.score).toBeLessThan(STRONG_MATCH);
  });

  it("finds nothing for ordinary business names, and at most a possible match on common words", () => {
    const ordinary = [
      "Northwind Design",
      "Harbor Print Co",
      "Acme Cloud Services LLC",
      "Pacific Rim Imports",
      "Sunrise Bakery",
      "Riverbank Coffee Roasters",
      "Maple Leaf Consulting",
      "Summit Accounting Group",
      "Evergreen Cleaning Co",
      "Smith Global Trading",
      "Maria Garcia",
      "John Smith",
    ];
    for (const name of ordinary) expect(matchName(index, name), name).toEqual([]);
    // Common words alone make a possible match at most: "GLOBAL TRADING GROUP" is another name of a listed entity.
    expect(matchName(index, "Global Trading Company").map((match) => match.band)).toEqual(["possible", "possible"]);
    expect(top("Global Trading Company")).toMatchObject({ matched: "GLOBAL TRADING GROUP", listedOnly: ["group"] });
  });

  it("shows at most 3 entries, the highest first, an entry's own name before another name on a tie", () => {
    const matches = matchName(index, "Sberbank");
    expect(matches.length).toBeLessThanOrEqual(MATCHES_SHOWN);
    for (let at = 1; at < matches.length; at += 1) expect(matches[at - 1].score).toBeGreaterThanOrEqual(matches[at].score);
    const melli = matchName(index, "Melli Bank");
    expect(melli[0]).toMatchObject({ score: 1, via: "name", matched: "MELLI BANK PLC" });
    expect(melli[1]).toMatchObject({ score: 1, via: "other_name", matched: "MELLI BANK", entry: { number: 25578 } });
  });

  it("finds nothing for a blank name", () => {
    expect(matchName(index, " ,. ")).toEqual([]);
  });
});

describe("the country (CV5)", () => {
  it("says whether the entry's countries agree, reading codes, inverted names and other names", () => {
    expect(countryAgreement("Iran", ["France", "Iran"])).toEqual({ kind: "agrees", country: "Iran" });
    expect(countryAgreement("IR", ["Iran"])).toEqual({ kind: "agrees", country: "Iran" });
    expect(countryAgreement("north korea", ["Korea, North"])).toEqual({ kind: "agrees", country: "Korea, North" });
    expect(countryAgreement("KP", ["Korea, North"])).toEqual({ kind: "agrees", country: "Korea, North" });
    expect(countryAgreement("DPRK", ["Korea, North"])).toEqual({ kind: "agrees", country: "Korea, North" });
    expect(countryAgreement("UAE", ["United Arab Emirates"])).toEqual({ kind: "agrees", country: "United Arab Emirates" });
    expect(countryAgreement("Myanmar", ["Burma"])).toEqual({ kind: "agrees", country: "Burma" });
    expect(countryAgreement("Türkiye", ["Turkey"])).toEqual({ kind: "agrees", country: "Turkey" });
    expect(countryAgreement("Brazil", ["Iran", "Iraq"])).toEqual({ kind: "differs", listed: ["Iran", "Iraq"] });
    expect(countryAgreement("Brazil", [])).toEqual({ kind: "not_listed" });
    expect(countryAgreement(" ", ["Iran"])).toEqual({ kind: "not_given" });
  });

  it("is shown on each match without changing its score or band", () => {
    const given = top("Bank Melli Iran", "IR");
    expect(given.country).toEqual({ kind: "agrees", country: "Iran" });
    const other = matchName(index, "Bank Melli Iran", "Brazil").find((match) => match.entry.number === 25578)!;
    expect(other.country.kind).toBe("differs");
    expect(other.score).toBe(given.score);
    expect(other.band).toBe(given.band);
    expect(top("Lazarus Group", "North Korea").country).toEqual({ kind: "agrees", country: "Korea, North" });
  });
});
