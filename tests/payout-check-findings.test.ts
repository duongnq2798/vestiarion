import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { madeToLookAlike, PARTIAL_MIN, readKnownAddresses, sharedEnds, type KnownAddress } from "@/lib/address-check";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";
import {
  checkPayoutRows,
  checkPayouts,
  lookalikeNeighbours,
  NEIGHBOURS_KEPT,
  payoutCheckWords,
  payoutVerdict,
  rowWords,
  sumDecimals,
  tokenDigits,
  tokenLabel,
  tokenOf,
  VERDICT_WORDS,
  type FindingKind,
  type PayoutCheck,
  type PayoutFinding,
} from "@/lib/payout-check/findings";
import { payoutRows, readPayoutBatch, startingPayoutAnswers } from "@/lib/payout-check/read";

/**
 * What the payout batch check finds (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP3-CP8): each row's
 * address with the address checker's rules, every address against every other through buckets that miss no pair a
 * brute-force comparison finds, the same address on several rows and one name with several addresses, the addresses
 * paid before, tokens, amounts against their token's median, exact totals, and each row's verdict. Hidden characters
 * and letters from other alphabets are made with String.fromCharCode, so none is hidden in this file.
 */

const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const [LISTED] = snapshot.wallets;

const NORTHWIND = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";
/** Northwind's first 4 and last 4 digits, and nothing else: made to look like it. */
const LOOKALIKE = "0x7a2d8f06c3e1b9a457d02c6e8f1b3a9d4e7ce10d";
/** Northwind's first 4 digits, and nothing else at either end. */
const PARTIAL = "0x7a2d11111111111111111111111111111111111a";
const B = "0x562acedfa970dc60f109f21c66507b752413f4fb";
const C = "0x59bd40189e7f95b34975ecf4cf3da46ba8481133";
const D = "0x9b0cb8709c006b11475dd0ea18885dd78ba7c7ad";
const USDC_ON_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FAKE_USDC = "0x833522497C4013027398e6351d9beA7058412913";
const UNKNOWN_TOKEN = "0x6B175474E89094C44Da98b954EedeAC495271d0F";

const run = (text: string, known: readonly KnownAddress[] = []): PayoutCheck => {
  const table = readPayoutBatch(text);
  return checkPayouts(table, startingPayoutAnswers(table), { sanctioned, known });
};
const resultOn = (check: PayoutCheck, line: number) => check.results.find((result) => result.row.line === line)!;
const kinds = (check: PayoutCheck, line: number) => resultOn(check, line).findings.map((finding) => finding.kind);
const found = (check: PayoutCheck, line: number, kind: FindingKind) => resultOn(check, line).findings.find((finding) => finding.kind === kind);

describe("each row's address (payout check CP3)", () => {
  it("says to fix a hidden character, a letter from another alphabet, a missing 0x, a wrong length or a character that is not hex", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const rows = [
      `${NORTHWIND.slice(0, 20)}${zeroWidth}${NORTHWIND.slice(20)}`,
      `${zeroWidth}${NORTHWIND}`,
      `0${String.fromCharCode(0x0445)}${NORTHWIND.slice(2)}`,
      `0x7${String.fromCharCode(0x0430)}${NORTHWIND.slice(4)}`,
      `0x${String.fromCharCode(0xff17)}${NORTHWIND.slice(3)}`,
      NORTHWIND.slice(2),
      NORTHWIND.slice(0, 41),
      `0x${"g".repeat(40)}`,
    ];
    const check = run(["Address,Amount", ...rows.map((address) => `${address},10`)].join("\n"));
    expect(check.results.map((result) => [result.verdict, result.findings[0].kind])).toEqual(rows.map(() => ["fix", "not_address"]));
    const texts = check.results.map((result) => result.findings[0].text);
    expect(texts[0]).toContain("a character you cannot see");
    expect(texts[0]).toContain("U+200B");
    expect(texts[1]).toContain("U+200B");
    expect(texts[2]).toContain("only looks like “x”");
    expect(texts[3]).toContain("only looks like “a”");
    expect(texts[4]).toContain("only looks like “7”");
    expect(texts[5]).toBe("Not an address. An address starts with 0x: this one has its 40 digits without it.");
    expect(texts[6]).toContain("It has 39 characters after 0x");
    expect(texts[7]).toContain("is not 0–9 or a–f");
  });

  it("stops at an invalid checksum, and passes a valid one or an address in one case", () => {
    const checksummed = getAddress(NORTHWIND);
    const wrong = `${checksummed.slice(0, -1)}${checksummed.at(-1) === "d" ? "D" : "d"}`;
    const check = run(`Address,Amount\n${wrong},1\n${checksummed},2\n${NORTHWIND.toUpperCase().replace("0X", "0x")},3`);
    expect(resultOn(check, 2).verdict).toBe("stop");
    expect(resultOn(check, 2).findings[0]).toEqual({
      level: "stop",
      kind: "checksum",
      text: "Its checksum does not match (EIP-55), so a character was mistyped or changed.",
    });
    // The same wallet three times, in three cases, is a look, and no fault of the two whose case carries no error.
    expect(resultOn(check, 3)).toMatchObject({ verdict: "look", address: { check: { checksum: "valid" } } });
    expect(resultOn(check, 4)).toMatchObject({ verdict: "look", address: { check: { checksum: "none" } } });
  });

  it("stops at an address on OFAC's SDN list, naming its entry", () => {
    const check = run(`Address,Amount\n${getAddress(LISTED.address)},10`);
    expect(resultOn(check, 2)).toMatchObject({ verdict: "stop", findings: [{ kind: "sanctioned", text: `On OFAC's SDN list, under ${LISTED.name}.` }] });
  });

  it("stops at the zero and burn addresses and a token contract as the receiver: money sent there does not reach a person", () => {
    const check = run(`Address,Amount\n0x${"0".repeat(40)},1\n0x000000000000000000000000000000000000dEaD,2\n${USDC_ON_BASE},3`);
    expect(check.results.map((result) => [result.verdict, result.findings[0].text])).toEqual([
      ["stop", "This is the zero address: anything sent to it is lost."],
      ["stop", "This is a burn address: anything sent to it is lost."],
      ["stop", "This is the USDC on Base token contract, not a wallet."],
    ]);
  });

  it("does not look up an ENS name or check another currency's address, and says so, as a look", () => {
    const check = run(
      "Address,Amount\nnorthwind.eth,1\nharbor.base.eth,2\nbc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq,3\nTNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81,4\n7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV,5"
    );
    expect(resultOn(check, 2).findings).toEqual([
      { level: "look", kind: "ens", text: "Not checked: an ENS name is not looked up here. Check the address it points to on the day you pay." },
    ]);
    expect(resultOn(check, 3).address).toEqual({ kind: "ens", name: "harbor.base.eth" });
    for (const line of [4, 5, 6]) {
      expect(resultOn(check, line)).toMatchObject({ verdict: "look", findings: [{ level: "look", kind: "not_evm", text: "Not checked: only EVM addresses (0x) are checked." }] });
    }
  });

  it("reads the address after a chain prefix or in a payment link, says what it read, and checks it", () => {
    const check = run(`Address,Amount\nbase:${LISTED.address},1\nethereum:${NORTHWIND}@1,2\nethereum:${USDC_ON_BASE}@8453/transfer?value=1,3\n,4`);
    expect(resultOn(check, 2)).toMatchObject({ verdict: "stop", address: { kind: "evm", read: LISTED.address } });
    expect(kinds(check, 2)).toEqual(["sanctioned", "read_as"]);
    expect(found(check, 2, "read_as")!.text).toBe(`Read as ${LISTED.address}.`);
    expect(resultOn(check, 3)).toMatchObject({ verdict: "nothing_found", address: { kind: "evm", read: NORTHWIND } });
    expect(resultOn(check, 4)).toMatchObject({ verdict: "fix", findings: [{ kind: "not_address", text: expect.stringContaining("calls a contract and gives no pay-to address") }] });
    expect(resultOn(check, 5)).toMatchObject({ verdict: "fix", findings: [{ kind: "no_address", text: "No address." }] });
  });

  it("takes no Latin letter of a chain prefix or a link's label for a lookalike, and names another alphabet's letter where it stands in the cell (payout check CP3)", () => {
    const accented = `Caf${String.fromCharCode(0xe9)}`;
    const combining = `Cafe${String.fromCharCode(0x301)}`;
    const check = run(
      [
        "Address,Amount",
        `polygon:${NORTHWIND}?label=${accented},1`,
        `ethereum:${B}@8453?label=${accented},2`,
        `ethereum:${C}?label=${combining},3`,
        `linea:0x7${String.fromCharCode(0x0430)}${NORTHWIND.slice(4)},4`,
        `linea:0${String.fromCharCode(0x0445)}${NORTHWIND.slice(2)},5`,
      ].join("\n")
    );
    expect(resultOn(check, 2)).toMatchObject({ verdict: "nothing_found", address: { kind: "evm", read: NORTHWIND } });
    expect(resultOn(check, 3)).toMatchObject({ verdict: "nothing_found", address: { kind: "evm", read: B } });
    expect(resultOn(check, 4)).toMatchObject({ verdict: "nothing_found", address: { kind: "evm", read: C } });
    expect(resultOn(check, 5).findings[0].text).toMatch(/^Not an address\. Character 10, “.” \(U\+0430\), only looks like “a”\./);
    expect(resultOn(check, 6).findings[0].text).toMatch(/^Not an address\. Character 8, “.” \(U\+0445\), only looks like “x”\./);
  });
});

describe("across the batch (payout check CP4)", () => {
  it("stops at both rows of a pair made to look alike, naming the other row, the digits they share and how rare that is", () => {
    const check = run(`Name,Address,Amount\nNorthwind Design,${NORTHWIND},100\nOrchid Studio,${LOOKALIKE},90\nHarbor,${B},80`);
    expect(resultOn(check, 2)).toMatchObject({
      verdict: "stop",
      findings: [
        {
          level: "stop",
          kind: "alike_row",
          text: "Made to look like the address on row 3 (Orchid Studio). It shares its first 4 and last 4 digits, which a random address does about once in 4.3 billion: one of the two is very likely not the payee's.",
        },
      ],
      pairs: [{ address: LOOKALIKE, lines: [3], name: "Orchid Studio", leading: 4, trailing: 4, alike: true }],
    });
    expect(found(check, 3, "alike_row")!.text).toContain("the address on row 2 (Northwind Design)");
    expect(resultOn(check, 4).verdict).toBe("nothing_found");
  });

  it("looks at an address sharing 4 digits at an end with another row's, and names every other lookalike", () => {
    const fiveAtEnd = `0x${"1".repeat(35)}${NORTHWIND.slice(-5)}`;
    const check = run(`Address,Amount\n${NORTHWIND},1\n${PARTIAL},2\n${LOOKALIKE},3\n${fiveAtEnd},4`);
    expect(found(check, 3, "partial_row")).toEqual({
      level: "look",
      kind: "partial_row",
      text: "Shares its first 4 digits with the address on row 2. Compare the whole address. Row 4 shares 4 digits at an end with it too.",
    });
    expect(resultOn(check, 3).verdict).toBe("look");
    // The pair sharing the most digits is named first.
    expect(found(check, 2, "alike_row")!.text).toMatch(/^Made to look like the address on row 4\. It shares its first 4 and last 4 digits.*Row 5 has an address made to look like it too\.$/);
    expect(found(check, 5, "alike_row")!.text).toContain("It shares its last 5 digits, which a random address does about once in 1 million");
    expect(found(check, 2, "partial_row")!.text).toContain("with the address on row 3");
  });

  it("names first the pair sharing the most digits, though its bucket is looked in last", () => {
    // P shares Northwind's first 3 and last 3 digits, found in the first bucket; Q its first 8, found in a later one.
    const P = `0x7a2${"0".repeat(34)}10d`;
    const Q = `0x7a2dc41e${"0".repeat(31)}1`;
    expect(lookalikeNeighbours([NORTHWIND, P, Q])[0].alike).toEqual([
      { index: 2, leading: 8, trailing: 0 },
      { index: 1, leading: 3, trailing: 3 },
    ]);
    const check = run(`Address,Amount\n${NORTHWIND},1\n${P},2\n${Q},3`);
    expect(resultOn(check, 2).pairs.map((pair) => pair.lines)).toEqual([[4], [3]]);
    expect(found(check, 2, "alike_row")!.text).toBe(
      "Made to look like the address on row 4. It shares its first 8 digits, which a random address does about once in 4.3 billion: one of the two is very likely not the payee's. Row 3 has an address made to look like it too."
    );
  });

  it("sizes the claim to the batch: a pair sharing no more digits than a batch this size shares by chance is a look, saying how often (payout check CP4)", () => {
    const random = seeded(4);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const fiveFirst = `0x7a2dc${"0".repeat(34)}1`;
    const filler = Array.from({ length: 196 }, (_, index) => `Payee ${index},0x${hex(40)},5`);
    const check = run(["Name,Address,Amount", `Northwind Design,${NORTHWIND},100`, `Orchid Studio,${LOOKALIKE},90`, `Fern,${fiveFirst},80`, ...filler].join("\n"));
    // 199 addresses compare 19,701 pairs: 5 digits shared happens by chance about once in 53 such batches, 4 and 4 almost never.
    expect(resultOn(check, 4)).toMatchObject({
      verdict: "look",
      findings: [
        {
          level: "look",
          kind: "alike_row",
          text: "Shares its first 5 digits with the address on row 2 (Northwind Design): in a batch of 199 addresses, a pair shares that many digits by chance about once in 53 batches. Compare the whole address.",
        },
        { kind: "partial_row" },
      ],
    });
    expect(resultOn(check, 2).verdict).toBe("stop");
    expect(resultOn(check, 2).findings.map((finding) => [finding.level, finding.kind])).toEqual([
      ["stop", "alike_row"],
      ["look", "alike_row"],
    ]);
    expect(found(check, 3, "alike_row")!.level).toBe("stop");
  });

  it("tells no row of a batch of 2,000 unrelated addresses to stop, though some share 5 digits by chance (payout check CP4)", () => {
    const random = seeded(2000);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const addresses = Array.from({ length: 2000 }, () => `0x${hex(40)}`);
    const check = run(["Address,Amount", ...addresses.map((address, index) => `${address},${index + 1}`)].join("\n"));
    const chance = check.results.filter((result) => result.findings.some((finding) => finding.kind === "alike_row"));
    // The pairs a batch this size holds by chance are there, and each is a look.
    expect(chance.length).toBeGreaterThan(0);
    expect(chance[0].findings.find((finding) => finding.kind === "alike_row")!.text).toMatch(/: in a batch of 2,000 addresses, .* that many digits by chance/);
    expect(check.counts.stop).toBe(0);
  });

  it("says when the same address is on more than one row: the row twice, two payees, or one paid twice", () => {
    const check = run(
      [
        "Name,Address,Amount",
        `Northwind Design,${NORTHWIND},100`,
        `Northwind Design Ltd.,${NORTHWIND.toUpperCase().replace("0X", "0x")},100.00`,
        `Lumen Freight,base:${NORTHWIND},40`,
        `Cedar,${C},5`,
        `Cedar,${C},6`,
        `,${D},7`,
        `Harbor,${D},7`,
      ].join("\n")
    );
    expect(found(check, 2, "same_address")!.text).toBe("The same address, name and amount as row 3: this payment may be in the batch twice.");
    expect(resultOn(check, 2).findings.filter((finding) => finding.kind === "same_address").map((finding) => finding.text)).toEqual([
      "The same address, name and amount as row 3: this payment may be in the batch twice.",
      "The same address as row 4, given there for Lumen Freight: one address for two payees.",
    ]);
    // Two spellings of one name are named once, as the first row writes it.
    expect(found(check, 4, "same_address")!.text).toBe("The same address as rows 2 and 3, given there for Northwind Design: one address for two payees.");
    expect(found(check, 5, "same_address")!.text).toBe("The same address as row 6, for another amount: it is paid more than once in the batch.");
    expect(found(check, 8, "same_address")!.text).toBe("The same address as row 7, with no name there: check one address is meant for both.");
    expect(resultOn(check, 5).verdict).toBe("look");
    // Without names or amounts, the rows share the address alone.
    expect(found(run(`${NORTHWIND}\n${NORTHWIND}`), 1, "same_address")!.text).toBe("The same address as row 2: this payment may be in the batch twice.");
  });

  it("looks at a name given two or more addresses, its names compared without case, punctuation or a legal suffix", () => {
    const check = run(`Name,Address,Amount\nNorthwind Design Ltd.,${NORTHWIND},1\nHarbor,${B},2\nnorthwind design,${C},3\nNORTHWIND DESIGN,northwind.eth,4`);
    expect(found(check, 2, "name_addresses")).toEqual({
      level: "look",
      kind: "name_addresses",
      text: "Northwind Design Ltd. is given another address on rows 4 and 5. Check which one is theirs.",
    });
    expect(found(check, 4, "name_addresses")!.text).toBe("northwind design is given another address on rows 2 and 5. Check which one is theirs.");
    expect(kinds(check, 3)).toEqual([]);
    // Names in another script are not one name for sharing a Latin word.
    const other = run(`Name,Address,Amount\n東京 Design,${NORTHWIND},1\n大阪 Design,${C},2`);
    expect(other.counts.nothingFound).toBe(2);
  });

  it("finds through its buckets every pair a brute-force comparison of every two addresses finds", () => {
    const random = seeded(20261102);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const addresses = new Set<string>();
    while (addresses.size < 3000) addresses.add(`0x${hex(40)}`);
    const base = [...addresses];
    // Planted lookalikes: each at a random address's ends, from 3 at each end to 6 at one, and 4 at one (partial).
    const shapes: Array<[number, number]> = [[3, 3], [4, 4], [5, 0], [0, 5], [6, 4], [3, 7], [4, 0], [0, 4], [4, 2], [2, 4], [8, 0]];
    for (let index = 0; index < 400; index += 1) {
      const target = base[Math.floor(random() * base.length)].slice(2);
      const [leading, trailing] = shapes[index % shapes.length];
      const middle = [...target.slice(leading, 40 - trailing)].map((digit, at) => (at === 0 || at === 39 - leading - trailing ? ((parseInt(digit, 16) + 1) % 16).toString(16) : hex(1))).join("");
      addresses.add(`0x${target.slice(0, leading)}${middle}${target.slice(40 - trailing)}`);
    }
    const list = [...addresses];
    const bucketed = lookalikeNeighbours(list);
    let alikePairs = 0;
    let partialPairs = 0;
    for (let a = 0; a < list.length; a += 1) {
      const alike: number[] = [];
      const partial: number[] = [];
      for (let b = 0; b < list.length; b += 1) {
        if (a === b) continue;
        const ends = sharedEnds(list[a], list[b]);
        if (madeToLookAlike(ends)) alike.push(b);
        else if (ends.leading >= PARTIAL_MIN || ends.trailing >= PARTIAL_MIN) partial.push(b);
      }
      alikePairs += alike.length;
      partialPairs += partial.length;
      expect(bucketed[a].alike.map((near) => near.index).sort((x, y) => x - y), `alike ${a}`).toEqual(alike);
      expect(bucketed[a].partial.map((near) => near.index).sort((x, y) => x - y), `partial ${a}`).toEqual(partial);
    }
    // The planted pairs are there to be found.
    expect(alikePairs).toBeGreaterThan(400);
    expect(partialPairs).toBeGreaterThan(100);
  });

  it(`stays fast when thousands of addresses share their ends, telling each about at most ${NEIGHBOURS_KEPT} of each kind`, () => {
    const random = seeded(11);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const addresses = [...new Set(Array.from({ length: 5000 }, () => `0x7a2d${hex(36)}`))];
    const started = performance.now();
    const near = lookalikeNeighbours(addresses);
    expect(performance.now() - started).toBeLessThan(3000);
    // About 300 share a fifth digit too, and are made to look alike; the rest share 4 digits.
    expect(near.every((each) => each.alike.length === NEIGHBOURS_KEPT && each.partial.length === NEIGHBOURS_KEPT)).toBe(true);
    for (let index = 0; index < near.length; index += 97) {
      expect(near[index].alike.every((other) => madeToLookAlike(sharedEnds(addresses[index], addresses[other.index])))).toBe(true);
      expect(near[index].partial.some((other) => madeToLookAlike(sharedEnds(addresses[index], addresses[other.index])))).toBe(false);
    }
  });

  it("finds an address made to look like another in a bucket full of ones sharing only 4 digits with it", () => {
    const random = seeded(12);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const target = `0x7a2d0${hex(32)}abc`;
    // Thousands with the target's first 4 digits and another fifth, and never its last 3.
    const partial = Array.from({ length: 4000 }, (_, index) => `0x7a2d${"123456789abcdef"[index % 15]}${hex(32)}${index % 2 === 0 ? "01" : "10"}${hex(1)}`);
    const lookalike = `0x7a2d0${hex(32)}def`;
    const near = lookalikeNeighbours([...partial, target, lookalike]);
    expect(near[4000].alike).toEqual([{ index: 4001, leading: 5, trailing: 0 }]);
    expect(near[4000].partial).toHaveLength(NEIGHBOURS_KEPT);
  });

  it("checks a batch of 5,000 rows fast", () => {
    const random = seeded(7);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const lines = Array.from({ length: 5000 }, (_, index) => `Payee ${index % 900},0x${hex(40)},${(index % 97) + 1}.25,USDC`);
    const started = performance.now();
    const check = run(["Name,Address,Amount,Token", ...lines].join("\n"));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(check.counts.rows).toBe(5000);
  });
});

describe("the addresses you have paid before (payout check CP5)", () => {
  const { known } = readKnownAddresses(`Northwind Design, ${NORTHWIND}\nHarbor Print, ${B}`);

  it("says a row was paid before, stops at one made to look like a known address and looks at one sharing 4 digits", () => {
    // One row a batch, so the rows are compared with the known addresses alone.
    const one = (address: string) => resultOn(run(`Address,Amount\n${address},1`, known), 2);
    expect(one(NORTHWIND)).toMatchObject({ verdict: "nothing_found", findings: [{ level: "note", kind: "paid_before", text: "Paid before as Northwind Design." }] });
    expect(one(LOOKALIKE)).toMatchObject({
      verdict: "stop",
      findings: [
        {
          level: "stop",
          kind: "alike_known",
          text: "Made to look like Northwind Design's address, one you have paid before. It shares its first 4 and last 4 digits, which a random address does about once in 4.3 billion.",
        },
      ],
    });
    expect(one(PARTIAL)).toMatchObject({
      verdict: "look",
      findings: [{ level: "look", kind: "partial_known", text: "Shares its first 4 digits with Northwind Design's address, one you have paid before. Compare the whole address." }],
    });
    expect(one(C).verdict).toBe("nothing_found");
    expect(run(`Address\n${C}`, known).known).toBe(2);
    expect(run(`Address\n${NORTHWIND}`).known).toBe(0);
  });

  it("looks, rather than stops, at a row sharing 5 digits with an address paid before when the batch and the list hold enough pairs to share them by chance (payout check CP4, CP5)", () => {
    const random = seeded(5);
    const hex = (length: number) => Array.from({ length }, () => "0123456789abcdef"[Math.floor(random() * 16)]).join("");
    const { known: many } = readKnownAddresses([`Northwind Design, ${NORTHWIND}`, ...Array.from({ length: 199 }, (_, index) => `Known ${index}, 0x${hex(40)}`)].join("\n"));
    expect(many).toHaveLength(200);
    const fiveFirst = `0x7a2dc${"0".repeat(34)}1`;
    const check = run(["Address,Amount", `${fiveFirst},1`, ...Array.from({ length: 59 }, (_, index) => `0x${hex(40)},${index + 2}`)].join("\n"), many);
    // 60 addresses against 200 are 12,000 pairs: 5 digits shared by chance about once in 87 such batches.
    expect(found(check, 2, "alike_known")).toEqual({
      level: "look",
      kind: "alike_known",
      text: "Shares its first 5 digits with Northwind Design's address, one you have paid before: among 60 addresses and the 200 addresses you have paid before, a pair shares that many digits by chance about once in 87 batches. Compare the whole address.",
    });
    expect(resultOn(check, 2).verdict).toBe("look");
  });

  it("stops at an address paid before when the known addresses also hold one made to look like it", () => {
    const { known: both } = readKnownAddresses(`Northwind Design, ${NORTHWIND}\nFrom history, ${LOOKALIKE}`);
    const check = run(`Address\n${NORTHWIND}`, both);
    expect(resultOn(check, 2).verdict).toBe("stop");
    expect(found(check, 2, "alike_known")!.text).toBe(
      "It is Northwind Design's address as you have paid it, but From history's, also among the addresses you have paid, is made to look like it: it shares its first 4 and last 4 digits. One of the two is not the payee's."
    );
  });
});

describe("tokens (payout check CP7)", () => {
  it("labels USDC and EURC contracts Vestiarion knows, symbols and the native coin, with their decimals", () => {
    expect(tokenOf(USDC_ON_BASE, "erc20", true)).toMatchObject({ kind: "contract", known: "USDC on Base", like: null });
    expect(tokenLabel(tokenOf(USDC_ON_BASE.toLowerCase(), "", false))).toBe("USDC on Base");
    expect(tokenLabel(tokenOf("0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", "", false))).toBe("EURC on Arc mainnet");
    expect(tokenDigits(tokenOf(USDC_ON_BASE, "erc20", false))).toBe(6);
    expect(tokenOf("usdc", "", false)).toEqual({ kind: "symbol", symbol: "usdc" });
    expect(tokenDigits(tokenOf("usdc", "", false))).toBe(6);
    expect(tokenDigits(tokenOf("ETH", "", false))).toBe(18);
    expect(tokenDigits(tokenOf("DAI", "", false))).toBeNull();
    expect(tokenOf("", "native", false)).toEqual({ kind: "native" });
    expect(tokenOf("", "", true)).toEqual({ kind: "native" });
    expect(tokenOf("", "", false)).toEqual({ kind: "none" });
    expect(tokenDigits({ kind: "native" })).toBe(18);
    expect(tokenDigits(tokenOf(UNKNOWN_TOKEN, "erc20", false))).toBeNull();
  });

  it("stops at a token contract made to look like a known one, and looks once at one the page does not know", () => {
    const check = run(
      [
        "token_type,token_address,receiver,amount",
        `erc20,${USDC_ON_BASE},${NORTHWIND},10`,
        `erc20,${FAKE_USDC},${B},10`,
        `erc20,${UNKNOWN_TOKEN},${C},10`,
        `erc20,${UNKNOWN_TOKEN},${D},10`,
        `native,,${PARTIAL.replace("7a2d", "1234")},0.5`,
      ].join("\n")
    );
    expect(resultOn(check, 2).verdict).toBe("nothing_found");
    expect(found(check, 3, "token_alike")).toEqual({
      level: "stop",
      kind: "token_alike",
      text: "The token contract is made to look like USDC on Base's: it shares its first 4 and last 4 digits. Fake tokens with a real token's ends are sent to wallets' histories so a copied row pays the wrong contract.",
    });
    expect(found(check, 4, "token_unknown")!.text).toBe("A token this page does not know: check its contract before you send it.");
    expect(resultOn(check, 5).verdict).toBe("look");
    const unknown = check.tokens.find((use) => use.label === UNKNOWN_TOKEN)!;
    expect(unknown).toMatchObject({ lines: [4, 5], finding: { kind: "token_unknown" } });
    expect(check.tokens.map((use) => [use.label, use.lines])).toEqual([
      ["USDC on Base", [2]],
      [getAddress(FAKE_USDC), [3]],
      [UNKNOWN_TOKEN, [4, 5]],
      ["native coin", [6]],
    ]);
    expect(resultOn(check, 6).verdict).toBe("nothing_found");
  });

  it("reads a token contract after a chain prefix, in a payment link or without its 0x, as the address column reads one, never as a symbol (payout check CP7)", () => {
    const check = run(
      [
        "receiver,amount,token",
        `${NORTHWIND},100,base:${FAKE_USDC}`,
        `${B},100,${FAKE_USDC.slice(2)}`,
        `${C},1,ethereum:${USDC_ON_BASE}@8453/transfer?address=${D}`,
        `${D},1,USDC`,
      ].join("\n")
    );
    expect(resultOn(check, 2)).toMatchObject({ verdict: "stop", token: { kind: "contract", address: FAKE_USDC.toLowerCase(), like: { label: "USDC on Base" } } });
    expect(found(check, 3, "token")).toEqual({
      level: "fix",
      kind: "token",
      text: "The token contract is not an address. An address starts with 0x: this one has its 40 digits without it.",
    });
    // A link's target is the token; its address= is the payee.
    expect(resultOn(check, 4)).toMatchObject({ verdict: "nothing_found", token: { kind: "contract", known: "USDC on Base" } });
    expect(resultOn(check, 5).token).toEqual({ kind: "symbol", symbol: "USDC" });
  });

  it("says to fix a token cell that cannot be read, and stops at a token contract whose checksum does not match", () => {
    // USDC on Base's contract with one letter's case changed.
    const wrong = USDC_ON_BASE.replace("fCD6", "fcD6");
    const check = run(
      ["token_type,token_address,receiver,amount", `erc721x,,${NORTHWIND},1`, `erc20,,${B},1`, `erc20,0x8335,${C},1`, `erc20,${wrong},${D},1`, `nft,,0x${"4".repeat(40)},`].join("\n")
    );
    expect(found(check, 2, "token")!.text).toBe("Token type “erc721x” is not one Safe reads: erc20, native or nft.");
    expect(found(check, 3, "token")!.text).toBe("An erc20 row needs its token's contract address.");
    expect(found(check, 4, "token")!.text).toMatch(/^The token contract is not an address\. It has 4 characters after 0x/);
    expect(found(check, 5, "token_checksum")!.level).toBe("stop");
    expect(resultOn(check, 6)).toMatchObject({ verdict: "fix", amount: null, findings: [{ text: "An NFT row needs its contract's address." }] });
    // A row whose token cannot be read is left out of the totals; an NFT row's amount is not read at all.
    expect(check.notTotalled).toBe(3);
    expect(check.nftRows).toBe(1);
  });
});

describe("amounts and totals (payout check CP6)", () => {
  it("sums exact decimals, never through a float, at 6 and 18 decimals", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["0.000001", "0.999999", "1"])).toBe("2");
    expect(sumDecimals(["0.000000000000000001", "1.999999999999999999"])).toBe("2");
    expect(sumDecimals(["99999999999999.999999", "0.000001"])).toBe("100000000000000");
    expect(sumDecimals([])).toBe("0");
  });

  it("totals each token as the batch names it, leaving out the rows whose amount is to fix", () => {
    const check = run(
      [
        "Address,Amount,Token",
        `${NORTHWIND},0.1,USDC`,
        `${B},0.2,usdc`,
        `${C},0.000000000000000001,ETH`,
        `${D},1.999999999999999999,ETH`,
        `0x${"1".repeat(40)},0.0000001,USDC`,
        `0x${"2".repeat(40)},ten,USDC`,
      ].join("\n")
    );
    expect(check.totals.map(({ label, rows, sum }) => [label, rows, sum])).toEqual([
      ["USDC", 2, "0.3"],
      ["ETH", 2, "2"],
    ]);
    expect(check.notTotalled).toBe(2);
    expect(found(check, 6, "amount")).toEqual({ level: "fix", kind: "amount", text: "Amount “0.0000001” has 7 decimals, and USDC has 6." });
    expect(found(check, 7, "amount")!.text).toBe("Amount “ten” is not a number.");
  });

  it("looks at an amount at least 100 times the median of the other amounts of its token, and not at another token's", () => {
    const rows = (amounts: string[], token = "USDC") => amounts.map((amount, index) => `0x${(index + 1).toString(16).padStart(40, "a")},${amount},${token}`);
    // The median of the others is 10 and 10.5: 10.25. 1025 is 100 times it, 1024.99 is not.
    const check = run(["Address,Amount,Token", ...rows(["10", "10.5", "1025", "9", "11"]), ...rows(["1024.99"], "EURC")].join("\n"));
    expect(found(check, 4, "large_amount")).toEqual({
      level: "look",
      kind: "large_amount",
      text: "At least 100 times the median of the other USDC amounts in the batch, 10.25: a decimal point may have moved, or the amount is written in base units.",
    });
    expect(check.results.filter((result) => found(check, result.row.line, "large_amount")).map((result) => result.row.line)).toEqual([4]);
    const under = run(["Address,Amount", ...rows(["10", "10.5", "1024.99", "9", "11"]).map((row) => row.replace(/,USDC$/, ""))].join("\n"));
    expect(under.counts.look).toBe(0);
    // An amount written in base units: 250 USDC as 250000000.
    const baseUnits = run(["Address,Amount,Token", ...rows(["250", "300", "250000000"])].join("\n"));
    expect(found(baseUnits, 4, "large_amount")!.text).toContain("the other USDC amounts in the batch, 275:");
  });

  it("checks a batch without an amount column for its addresses alone", () => {
    const check = run(`Name,Address\nNorthwind,${NORTHWIND}\nHarbor,${B}`);
    expect(check).toMatchObject({ amounts: false, totals: [], notTotalled: 0, counts: { rows: 2, nothingFound: 2 } });
    expect(check.results.every((result) => result.amount === null)).toBe(true);
  });
});

describe("verdicts (payout check CP8)", () => {
  const finding = (level: PayoutFinding["level"], text: string = level): PayoutFinding => ({ level, kind: "amount", text });

  it("gives each row its weightiest finding: fix, then stop, then look; nothing found when none", () => {
    expect(payoutVerdict([finding("look"), finding("stop"), finding("fix")])).toBe("fix");
    expect(payoutVerdict([finding("look"), finding("stop")])).toBe("stop");
    expect(payoutVerdict([finding("note"), finding("look")])).toBe("look");
    expect(payoutVerdict([finding("note")])).toBe("nothing_found");
    expect(payoutVerdict([])).toBe("nothing_found");
    expect(VERDICT_WORDS).toEqual({ fix: "Fix", stop: "Stop", look: "Look", nothing_found: "Nothing found" });
  });

  it("says a row's verdict and findings in one cell, each level named, notes last", () => {
    expect(payoutCheckWords({ findings: [] })).toBe("Nothing found");
    expect(payoutCheckWords({ findings: [finding("note", "Paid before as Northwind.")] })).toBe("Nothing found. Paid before as Northwind.");
    expect(payoutCheckWords({ findings: [finding("fix", "A."), finding("stop", "B."), finding("stop", "C."), finding("look", "D."), finding("note", "E.")] })).toBe(
      "Fix: A. Stop: B. C. Look: D. E."
    );
  });

  it("counts the rows by verdict, and orders each row's findings weightiest first", () => {
    const check = run(`Name,Address,Amount\nNorthwind,${NORTHWIND},1\nNorthwind,${LISTED.address},-1\nHarbor,${B},2`);
    expect(kinds(check, 3)).toEqual(["amount", "sanctioned", "name_addresses"]);
    expect(check.counts).toEqual({ rows: 3, fix: 1, stop: 0, look: 1, nothingFound: 1 });
  });

  it("never calls a row safe or verified", () => {
    const check = run(`Name,Address,Amount\nNorthwind,${NORTHWIND},1\nHarbor,${B},2`);
    for (const result of check.results) expect(payoutCheckWords(result)).not.toMatch(/safe|verified/i);
  });

  it("names rows in words", () => {
    expect(rowWords([7])).toBe("row 7");
    expect(rowWords([7, 9])).toBe("rows 7 and 9");
    expect(rowWords([2, 5, 7])).toBe("rows 2, 5 and 7");
    expect(rowWords([1, 2, 3, 4, 5, 6, 7, 8])).toBe("rows 1, 2, 3, 4, 5 and 3 more");
  });

  it("checks rows given directly, as the page does with its own answers", () => {
    const table = readPayoutBatch(`Address,Amount\n${NORTHWIND},1`);
    const { rows } = payoutRows(table, true, { address: 0, amount: 1 });
    const check = checkPayoutRows(rows, { sanctioned, known: [], decimalMark: ".", amounts: true, blankTokenIsNative: false, leftOut: 4 });
    expect(check).toMatchObject({ leftOut: 4, counts: { rows: 1, nothingFound: 1 }, totals: [{ label: "", sum: "1" }] });
  });
});

/** A small seeded random number generator (mulberry32), so a generated batch is the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
