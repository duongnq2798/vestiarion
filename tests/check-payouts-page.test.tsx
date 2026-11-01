// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Marked } from "@/components/address-check/AddressChecker";
import { TRY_HREF } from "@/components/landing/cta";
import { PayoutBatchChecker } from "@/components/payout-check/PayoutBatchChecker";
import { sharedEnds } from "@/lib/address-check";
import snapshot from "@/lib/data/ofac-sdn-evm-wallets.json";

/**
 * /check-payouts (docs/superpowers/specs/2026-11-02-check-payouts-design.md CP1, CP2, CP5, CP6, CP9-CP14): the free
 * payout batch check, rendered in a DOM and driven through its steps with the example batch, a Disperse list and pasted
 * rows, and the page around it: static, public, linked from the other tools, and with nothing that could send what is
 * pasted anywhere. Its start button is the shared one that credits a workspace to the tool, apart from the checker's
 * code (docs/superpowers/specs/2026-10-28-free-tool-attribution-design.md TA3, TA5, TA6).
 */

vi.mock("next/navigation", () => ({ usePathname: () => "/check-payouts", useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const sanctioned = snapshot.wallets.map(({ address, name }) => ({ address, name }));
const LIST_DATE = "Oct 28, 2026";
/** Northwind Design's address in the example, and two made up: they share no digits at either end. */
const NORTHWIND = "0x7a2Dc41E9b03F6a85D1C27E4b98F0A3C61d5e10d";
const FIRST = "0x1111111111111111111111111111111111111111";
const SECOND = "0x2222222222222222222222222222222222222222";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<PayoutBatchChecker sanctioned={sanctioned} listDate={LIST_DATE} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const text = () => container.textContent?.replace(/\s+/g, " ") ?? "";
const live = () => container.querySelector('[aria-live="polite"][data-results]')?.textContent?.replace(/\s+/g, " ") ?? "";

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  if (!found) throw new Error(`no button ${label}`);
  return found;
}

function click(label: string) {
  act(() => button(label).click());
}

/** Lets the check run: it waits for the page to show it is checking first (CP2). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

function type(control: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(control), "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const pasteBox = () => container.querySelector<HTMLTextAreaElement>("#check-payouts-paste")!;
const knownBox = () => container.querySelector<HTMLTextAreaElement>("#check-payouts-known")!;

/** Opens a folded section as a press on its summary does, telling the page it opened. */
function open(details: HTMLDetailsElement) {
  act(() => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

/** Pastes rows, reads them and checks them. */
async function checkPasted(rows: string) {
  type(pasteBox(), rows);
  click("Read the pasted rows");
  const start = [...container.querySelectorAll("button")].find((each) => /^Check \d+ rows?$/.test(each.textContent?.trim() ?? ""))!;
  act(() => start.click());
  await settle();
}

const section = (id: string) => container.querySelector(`section[aria-labelledby='${id}']`)?.textContent?.replace(/\s+/g, " ") ?? "";

/** The cards of the rows with a finding, in the order the page shows them. */
const cards = () => [...container.querySelectorAll("section[aria-labelledby='check-payouts-rows'] > div > ul > li")];

/** The words a row's card says, by its line. */
function card(line: number): string {
  const found = cards().find((each) => new RegExp(`^Row ${line}(?!\\d)`).test(each.textContent ?? ""));
  return found?.textContent?.replace(/\s+/g, " ") ?? "";
}

/** The page's words with Safe, the wallet's name, taken out, so the word itself can be looked for. */
const withoutSafeName = (words: string) => words.replace(/Safe(?=(?:'|&#x27;)s CSV| CSV)/g, "");

describe("the checker (payout check CP2, CP5, CP9-CP11)", () => {
  it("starts with the batch, a file or pasted rows, and has no form that could submit it", () => {
    expect(text()).toContain("1. Your batch");
    expect(text()).toContain("Choose a CSV file, or drop one here");
    expect(text()).toContain("A Safe CSV Airdrop file, a Disperse list, an exchange's batch withdrawal file or a sheet saved as CSV. Up to 5,000 rows and 2 MB.");
    expect(text()).toContain("Or paste rows from a sheet, or a Disperse list");
    expect(container.querySelector("form")).toBeNull();
    expect(pasteBox().getAttribute("autocomplete")).toBe("off");
    expect(pasteBox().getAttribute("spellcheck")).toBe("false");
    expect(button("Read the pasted rows").disabled).toBe(true);
    // 16 px on a phone, so the browser does not zoom into it.
    expect(pasteBox().className).toContain("text-base sm:text-xs");
  });

  it("reads the example in Safe's CSV Airdrop form, matches its columns, and asks nothing more (CP2, CP11)", () => {
    click("Try an example");
    expect(text()).toContain("2. Columns");
    expect(text()).toContain("Example payout batch (made-up payees): 14 rows, 6 columns.");
    expect(text()).toContain("Example data: made-up payees paid in USDC on Base");
    expect(text()).toContain(`Reads: ${NORTHWIND} · 0x562AcEDfA970Dc60f109F21C66507B752413f4Fb`);
    expect(text()).toContain("Reads: Northwind Design · Harbor Print Co · Cedar Coffee Roasters");
    // Every field the example has is matched, so none waits folded.
    for (const label of ["Address", "Name", "Amount", "Token", "Token type"]) {
      expect(container.querySelector(`label[for="check-payouts-column-${label === "Token type" ? "tokenType" : label.toLowerCase()}"]`)?.textContent).toContain(label);
    }
    expect(text()).not.toContain("Not in the batch:");
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(text()).toContain("Without them, the batch is compared only with itself.");
    expect(button("Check 14 rows").disabled).toBe(false);
    // A column's values break anywhere, in a track as wide as its column, so a payment link never widens a phone's page.
    const field = container.querySelector('label[for="check-payouts-column-address"]')!.parentElement!;
    expect(field.className).toContain("grid-cols-1");
    expect(field.className).toContain("[overflow-wrap:anywhere]");
  });

  it("checks the example and shows each planned finding, the counts, the totals and the list's date, with the summary announced (CP6-CP9)", async () => {
    click("Try an example");
    expect(live()).toBe("");
    click("Check 14 rows");
    // Busy for a frame, so a batch of thousands shows it is being checked before the page is held.
    expect(button("Check 14 rows").getAttribute("aria-busy")).toBe("true");
    expect(button("Check 14 rows").disabled).toBe(true);
    expect(live()).toBe("");
    await settle();

    expect(text()).toContain("3. What it found");
    expect(live()).toContain("Do not send this batch as it is");
    expect(live()).toContain("Checked 14 rows.");
    expect(live()).toContain("The batch was compared only with itself: add the addresses you have paid before to compare each row with them too.");
    expect(live()).toContain(`OFAC's SDN list as of ${LIST_DATE}.`);
    // The counts are announced with the summary.
    const counts = [...container.querySelectorAll("[data-results] dl > div")].map((tile) => [tile.querySelector("dt")?.textContent, tile.querySelector("dd")?.textContent]);
    expect(counts).toEqual([
      ["Rows read", "14"],
      ["To fix", "1"],
      ["To stop", "6"],
      ["To look at", "5"],
      ["Nothing found", "2"],
    ]);

    // CP4: the pair made to look alike, the name with two addresses and the row in twice.
    expect(card(2)).toContain("Northwind Design");
    expect(card(2)).toContain("Stop: Made to look like the address on row 6 (Orchid Studio). It shares its first 4 and last 4 digits");
    expect(card(6)).toContain("Stop: Made to look like the address on row 2 (Northwind Design).");
    expect(card(3)).toContain("Look: Harbor Print Co is given another address on row 12. Check which one is theirs.");
    expect(card(4)).toContain("Look: The same address, name and amount as row 7: this payment may be in the batch twice.");
    // CP3: OFAC's list, the checksum and the token contract as a receiver.
    expect(card(5)).toContain(`Stop: On OFAC's SDN list, under ${snapshot.wallets[0].name}.`);
    expect(card(8)).toContain("Stop: Its checksum does not match (EIP-55), so a character was mistyped or changed.");
    expect(card(9)).toContain("Stop: This is the USDC on Base token contract, not a wallet.");
    // CP6: an amount with too many decimals, and one 1,000 times the rest.
    expect(card(10)).toContain("Fix: Amount “1800.0000001” has 7 decimals, and USDC on Base has 6.");
    expect(card(11)).toContain("Look: At least 100 times the median of the other USDC on Base amounts in the batch, 400: a decimal point may have moved");
    // CP7: a token contract made to look like USDC's.
    expect(card(13)).toContain("Stop: The token contract is made to look like USDC on Base's: it shares its first 4 and last 4 digits.");
    // Each card names its row, its verdict, its amount and its token.
    expect(card(10)).toMatch(/^Row 10 · Redwood LegalFix/);
    expect(card(10)).toContain("Amount1800.0000001");
    expect(card(10)).toContain("TokenUSDC on Base");

    // CP9: the rows with a finding in batch order, then the rows with nothing found, folded.
    const rows = cards().map((each) => each.textContent?.match(/^Row (\d+)/)?.[1]);
    expect(rows).toEqual(["2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13"]);
    const folded = container.querySelector("details")!;
    expect(folded.open).toBe(false);
    expect(folded.querySelector("summary")?.textContent).toBe("2 rows with nothing found");
    // Drawn once opened, not while they wait folded.
    expect(folded.querySelectorAll("li")).toHaveLength(0);
    open(folded);
    expect(folded.textContent).toContain("Row 14 · Riverbank Bakery · 240 USDC on Base · 0x56E88F36Fa7f1550ac92491Bc047C82b756bdF50");
    expect(folded.textContent).toContain("Row 15 · Lakeside Freight");
    expect(folded.textContent).toContain("Nothing here says whose an address is.");

    // CP6, CP7: more than one token, each totalled exactly, the amount to fix left out; the unknown token once.
    expect(text()).toContain("More than one token");
    expect(text()).toContain("This batch pays 2 tokens. Check that each row pays the one you mean.");
    const totals = [...container.querySelectorAll("section[aria-labelledby='check-payouts-totals'] ul > li")].map((each) => each.textContent);
    expect(totals).toEqual(["USDC on Base · 12 rows405,285", "0x833522497C4013027398e6351d9beA7058412913 · 1 row300"]);
    expect(text()).toContain("1 row with an amount or a token to fix is left out of the totals.");
    const tokens = container.querySelector("section[aria-labelledby='check-payouts-tokens']")?.textContent?.replace(/\s+/g, " ") ?? "";
    // Named for what it holds: a stop here, not only tokens to look at.
    expect(container.querySelector("#check-payouts-tokens")?.textContent).toBe("Tokens with a finding");
    expect(tokens).toContain("0x833522497C4013027398e6351d9beA7058412913");
    expect(tokens).toContain("The token contract is made to look like USDC on Base's");
    expect(tokens).toContain("USDC on Base's contract0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(tokens).toContain("Row 13 pays it.");

    // The words never call a row more than nothing found.
    expect(withoutSafeName(text())).not.toMatch(/\b(?:safe|verified|cleared|compliant)\b/i);

    click("Check another batch");
    expect(text()).toContain("1. Your batch");
    expect(live()).toBe("");
  });

  it("marks the digits a lookalike pair shares, by more than colour, on both addresses (CP9)", async () => {
    click("Try an example");
    click("Check 14 rows");
    await settle();
    const [pair] = cards();
    expect(pair.textContent).toContain("This row's address");
    expect(pair.textContent).toContain("Row 6, Orchid Studio");
    // The shared ends underlined and bold, each digit between that differs bold on a tint, on both addresses.
    const ends = [...pair.querySelectorAll(".underline.font-semibold")].map((each) => each.textContent);
    expect(ends).toEqual(["7a2D", "e10d", "7a2D", "E10d"]);
    expect(pair.querySelectorAll(".bg-refused-soft.font-semibold").length).toBeGreaterThan(20);
    // Every character of each address is there, in order, so it reads whole.
    expect(pair.textContent).toContain(NORTHWIND);
    expect(pair.textContent).toContain("0x7a2D8F06c3e1b9a457d02C6e8f1B3A9d4e7cE10d");
    // A long address breaks rather than widen a phone's page.
    for (const marked of pair.querySelectorAll(".font-mono")) expect(marked.className).toContain("break-all");
    expect(pair.textContent).toContain("The digits they share at each end are underlined; the digits between them that differ are bold.");
  });

  it("marks only the digits that differ, whatever their case: two checksummed addresses compare as their digits do (CP9)", () => {
    const lower = NORTHWIND.toLowerCase();
    // Two middle digits changed: the checksum then writes some of the digits the two share in another case.
    const changed = `${lower.slice(0, 12)}${lower[12] === "0" ? "1" : "0"}${lower.slice(13, 30)}${lower[30] === "0" ? "1" : "0"}${lower.slice(31)}`;
    const [first, second] = [getAddress(lower), getAddress(changed)];
    const { leading, trailing } = sharedEnds(first, second);
    const middle = (address: string) => [...address.slice(2 + leading, 42 - trailing)];
    const otherCase = middle(first).filter((digit, at) => digit !== middle(second)[at] && digit.toLowerCase() === middle(second)[at].toLowerCase());
    expect(otherCase.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(<Marked address={first} other={second} leading={leading} trailing={trailing} />);
    expect(markup.match(/bg-refused-soft/g)).toHaveLength(2);
  });

  it("says which end a pair shares when it shares only one (CP9)", async () => {
    await checkPasted(`Name,Address,Amount\nA,0xabcd${"1".repeat(36)},1\nB,0xabcd${"2".repeat(36)},2`);
    expect(card(2)).toContain("Look: Shares its first 4 digits with the address on row 3 (B).");
    expect(card(2)).toContain("The first digits they share are underlined; the digits after them that differ are bold.");
    expect(card(2)).not.toContain("at each end");
  });

  it("shows a cell read after a chain prefix as it was written, beside what was read from it (CP3, CP9)", async () => {
    const quiet = "0x9876111111111111111111111111111111114321";
    await checkPasted(`Name,Address,Amount\nC,base:${quiet},2\nD,base:${FIRST},3\nE,${FIRST},4`);
    expect(card(3)).toContain(`base:${FIRST}`);
    expect(card(3)).toContain(`Note: Read as ${FIRST}.`);
    const folded = container.querySelector("details")!;
    open(folded);
    expect(folded.textContent?.replace(/\s+/g, " ")).toContain(`Row 2 · C · 2 · base:${quiet} Read as ${quiet}.`);
  });

  it("says NFT rows are not totalled, rather than that their amounts could not be read (CP6)", async () => {
    const contract = "0x1234567890123456789012345678901234567890";
    await checkPasted(`token_type,token_address,receiver,amount,id\nnft,${contract},${FIRST},,7\nerc721,${contract},${SECOND},1,8`);
    expect(section("check-payouts-totals")).toContain("2 NFT rows are not totalled: an NFT row's amount is not read.");
    expect(section("check-payouts-totals")).not.toContain("could be read");
  });

  it("still checks in a tab that draws no frames, as a background tab does (CP2)", async () => {
    const frames = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 0);
    click("Try an example");
    click("Check 14 rows");
    expect(button("Check 14 rows").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(frames).toHaveBeenCalled();
    expect(text()).toContain("3. What it found");
    expect(live()).toContain("Do not send this batch as it is");
  });

  it("downloads the example, and the batch back with its Payout check column, both made in the page (CP10, CP11)", async () => {
    const made: Blob[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      made.push(blob as Blob);
      return "blob:check";
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const saved = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    click("Download the example");
    expect((saved.mock.contexts[0] as HTMLAnchorElement).download).toBe("example-payout-batch.csv");
    expect((await made[0].text()).split("\n")[0]).toBe("token_type,token_address,receiver,amount,id,name");

    click("Try an example");
    click("Check 14 rows");
    await settle();
    click("Download the batch with the check");
    expect(saved).toHaveBeenCalledTimes(2);
    expect((saved.mock.contexts[1] as HTMLAnchorElement).download).toBe("Example-payout-batch-made-up-payees-checked.csv");
    const csv = await made[1].text();
    // A byte-order mark first, so a spreadsheet reads the names right.
    expect(csv.split("\r\n")[0]).toBe(`${String.fromCharCode(0xfeff)}token_type,token_address,receiver,amount,id,name,Payout check`);
    expect(csv).toContain("Stop: Made to look like the address on row 6 (Orchid Studio).");
    expect(csv).toContain(",Nothing found\r\n");
  });

  it("compares each row with the addresses paid before, and says which lines it could not read (CP5)", async () => {
    click("Try an example");
    type(knownBox(), `Northwind Design, ${NORTHWIND}\nOld wallet 0X12`);
    expect(text()).toContain("Read 1 address: each row is compared with it too.");
    expect(text()).toContain("Line 2 was not read.");
    click("Check 14 rows");
    await settle();
    expect(live()).toContain("Each row was compared with the rest of the batch and with the 1 address you have paid before.");
    expect(card(2)).toContain("Note: Paid before as Northwind Design.");
    expect(card(6)).toContain("Stop: Made to look like Northwind Design's address, one you have paid before.");
    // The addresses paid before stay while another batch is read, and nowhere else.
    click("Check another batch");
    click("Try an example");
    expect(knownBox().value).toContain(NORTHWIND);
  });

  it("reads a Disperse list, asks how its amounts are written when one reads two ways, and totals them with no token named (CP2, CP6)", async () => {
    type(pasteBox(), `${FIRST} 250\n${SECOND}=1,000`);
    click("Read the pasted rows");
    expect(text()).toContain("Pasted rows: 2 rows, 2 columns.");
    expect(text()).toContain("Read as a Disperse list: an address and an amount on each line, with no column names.");
    expect(text()).toContain("Amounts like 1,000 are written");
    expect(text()).toContain("Choose how the batch writes its amounts: 1,234.50 or 1.234,50.");
    expect(button("Check 2 rows").disabled).toBe(true);
    const dotFirst = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')][0];
    act(() => dotFirst.click());
    expect(button("Check 2 rows").disabled).toBe(false);
    click("Check 2 rows");
    await settle();
    expect(live()).toContain("Nothing found");
    expect(live()).toContain("None of these checks found anything.");
    const totals = [...container.querySelectorAll("section[aria-labelledby='check-payouts-totals'] ul > li")].map((each) => each.textContent);
    expect(totals).toEqual(["No token named · 2 rows1,250"]);
    expect(text()).toContain("None in this batch.");
    expect(text()).not.toContain("More than one token");
  });

  it("checks a batch with no amount column for its addresses alone, and says so (CP6)", async () => {
    type(pasteBox(), `Payee\tWallet\nNorthwind\t${FIRST}\nHarbor\t${FIRST}`);
    click("Read the pasted rows");
    expect(text()).toContain("Not in the batch: Amount, Token, Token type");
    click("Check 2 rows");
    await settle();
    expect(live()).toContain("The batch has no amount column, so its addresses alone were checked.");
    expect(text()).toContain("The batch has no amount column, so there is nothing to total.");
    expect(card(2)).toContain("Look: The same address as row 3, given there for Harbor: one address for two payees.");
  });

  it("says a token it does not know once, with the rows that pay it, and draws a long batch's rows a few hundred at a time (CP7, CP9)", async () => {
    const unknown = `0x${"ab".repeat(20)}`;
    // 205 made-up receivers that share no ends: 0x0001…0001, 0x0002…0002 and so on.
    const receivers = Array.from({ length: 205 }, (_, index) => `0x${(index + 1).toString(16).padStart(4, "0").repeat(10)}`);
    type(pasteBox(), ["token_type,token_address,receiver,amount", ...receivers.map((receiver) => `erc20,${unknown},${receiver},5`)].join("\n"));
    click("Read the pasted rows");
    click("Check 205 rows");
    await settle();
    expect(live()).toContain("Look at 205 rows before you send this batch");
    const tokens = container.querySelector("section[aria-labelledby='check-payouts-tokens']")?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(tokens.match(/A token this page does not know: check its contract before you send it\./g)).toHaveLength(1);
    // Its contract, checksummed.
    expect(tokens.toLowerCase()).toContain(unknown);
    expect(tokens).toContain("Rows 2, 3, 4, 5, 6 and 200 more pay it.");
    // Each row points to it rather than repeating it.
    expect(card(2)).toContain("Look: A token this page does not know: its contract is under Tokens with a finding, above.");
    expect(cards()).toHaveLength(200);
    expect(text()).toContain("Showing 200 of 205 rows with a finding. The download has every row.");
    click("Show 5 more");
    expect(cards()).toHaveLength(205);
    expect(text()).not.toContain("Showing 200");
    // The button is gone, and the focus with it went to the first row it drew, not to the page.
    expect(document.activeElement).toBe(cards()[200]);
    expect(cards()[200].textContent).toMatch(/^Row 202(?!\d)/);
  });

  it("asks for the address column when the batch has none it can find", () => {
    type(pasteBox(), "Payee\tNote\nNorthwind\tMarch");
    click("Read the pasted rows");
    expect(text()).toContain("Choose the column for Address.");
    expect(button("Check 0 rows").disabled).toBe(true);
  });

  it("moves the focus to each new step, where the pressed button was, so a keyboard carries on from there", async () => {
    const focused = () => document.activeElement?.textContent;
    expect(document.activeElement).toBe(document.body);
    click("Try an example");
    expect(focused()).toBe("2. Columns");
    click("Check 14 rows");
    await settle();
    expect(focused()).toBe("3. What it found");
    click("Change columns");
    expect(focused()).toBe("2. Columns");
    click("Choose another batch");
    expect(focused()).toBe("1. Your batch");
  });

  it("says when what was pasted cannot be read", () => {
    type(pasteBox(), 'receiver,amount\n"0x12,3');
    click("Read the pasted rows");
    expect(text()).toContain("A quoted field is never closed. Check the list's quotes, then try again.");
  });

  it("makes no request and touches no cookie or storage while it reads, checks and shows a batch (CP13)", async () => {
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    const opened = vi.spyOn(XMLHttpRequest.prototype, "open");
    const stored = vi.spyOn(Storage.prototype, "setItem");
    const read = vi.spyOn(Storage.prototype, "getItem");
    const cookie = document.cookie;
    click("Try an example");
    type(knownBox(), `Northwind Design, ${NORTHWIND}`);
    click("Check 14 rows");
    await settle();
    click("Change columns");
    click("Check 14 rows");
    await settle();
    expect(text()).toContain("3. What it found");
    expect(fetched).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(stored).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(document.cookie).toBe(cookie);
  });
});

describe("the page (payout check CP1, CP12-CP14)", () => {
  it("is static and public, with its own title, canonical address, cards and heading, and not under /tools", async () => {
    const page = source("src/app/check-payouts/page.tsx");
    expect(page).not.toMatch(/force-dynamic|searchParams|cookies\(|headers\(/);
    const { metadata, default: CheckPayoutsPage } = await import("@/app/check-payouts/page");
    expect(metadata).toMatchObject({
      title: "Batch payout address check, free",
      alternates: { canonical: "/check-payouts" },
      openGraph: { url: "/check-payouts" },
      twitter: { card: "summary_large_image" },
    });
    expect(withoutSafeName(String(metadata.description))).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
    const markup = renderToStaticMarkup(<CheckPayoutsPage />).replaceAll("&#x27;", "'");
    expect(markup).toMatch(/<h1[^>]*>Check a batch payout before you send it<\/h1>/);
    expect(markup).toContain(
      "The check runs in this page, and nothing you paste is kept. This page may count the visit and a click on Try it on your bills, by its address. What you paste or type is never sent. OFAC's SDN list as of Oct 28, 2026."
    );
    expect(page).toContain("{FREE_TOOL_COUNT_LINE}");
    expect(markup).toContain("How it works");
    expect(markup).toContain("What it does not do");
    expect(markup).toContain('href="/check-address"');
    expect(markup).toContain('href="/check-vendor"');
    expect(withoutSafeName(markup)).not.toMatch(/\b(?:safe|cleared|verified|compliant)\b/i);
    const { requiresSession } = await import("@/lib/auth/routes");
    expect(requiresSession("/check-payouts")).toBe(false);
  });

  it("ends with the call to action: the shared Try it on your bills, where the landing's goes, and the guide to the payee lock (CP12)", async () => {
    const page = source("src/app/check-payouts/page.tsx");
    const { default: CheckPayoutsPage } = await import("@/app/check-payouts/page");
    const markup = renderToStaticMarkup(<CheckPayoutsPage />).replaceAll("&#x27;", "'").replace(/\s+/g, " ");
    expect(markup).toContain(
      "Vestiarion locks each payee's payout address, checks it against OFAC's list and the payee's past addresses, and holds any payment whose address changes until someone confirms it, before it pays."
    );
    const link = /<a[^>]*data-cta="check-payouts-start"[^>]*>([^<]*)<\/a>/.exec(markup);
    expect(link?.[0]).toContain(`href="${TRY_HREF}"`);
    expect(link?.[1]).toBe("Try it on your bills");
    // The guide's section on the payee lock, which the address checker links too.
    expect(markup).toContain('href="/docs/guides/first-payment#payee-lock"');
    expect(source("content/docs/guides/first-payment.mdx")).toMatch(/^### Payee lock$/m);
    // The shared start button (free tool attribution TA3), named check-payouts-start for the analytics click.
    expect(page).toContain('<ToolCta tool="check-payouts" />');
    expect(markup.match(/data-cta="check-payouts-start"/g)).toHaveLength(1);
    // The full footer's Get started, the page's other start, credits the tool too (TA5).
    expect(page).toContain('<SiteFooter tool="check-payouts" />');
    expect(markup).toMatch(/<a [^>]*href="\/onboarding\?shadow=1"[^>]*>Get started<\/a>/);
  });

  it("is linked from the address checker for a whole batch, and from the vendor check for amounts and tokens (CP1)", async () => {
    const { default: CheckAddressPage } = await import("@/app/check-address/page");
    const address = renderToStaticMarkup(<CheckAddressPage />).replaceAll("&#x27;", "'").replace(/\s+/g, " ");
    expect(address).toMatch(/Sending a whole batch\? The <a [^>]*href="\/check-payouts"[^>]*>payout batch check<\/a>/);
    const { default: CheckVendorPage } = await import("@/app/check-vendor/page");
    const vendor = renderToStaticMarkup(<CheckVendorPage />).replaceAll("&#x27;", "'").replace(/\s+/g, " ");
    const covers = vendor.slice(vendor.indexOf('id="covers"'), vendor.indexOf('id="how"'));
    expect(covers).toMatch(/It does not read a payout file's amounts or tokens\. For a batch you are about to send, use the <a [^>]*href="\/check-payouts"[^>]*>payout batch check<\/a>/);
  });

  it("sends nothing anywhere: the checker, its rules and the page make no request, and read or write no address bar, storage or cookie (CP13)", () => {
    const files = [
      "src/components/payout-check/PayoutBatchChecker.tsx",
      "src/components/payout-check/PayoutCheckResults.tsx",
      // What the checker shares with the other tools is held to the same.
      "src/components/intake/list-steps.tsx",
      "src/components/address-check/AddressChecker.tsx",
      "src/lib/payout-check/read.ts",
      "src/lib/payout-check/findings.ts",
      "src/lib/payout-check/csv.ts",
      "src/lib/payout-check/sample.ts",
      "src/app/check-payouts/page.tsx",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(
        /fetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|useSearchParams|useRouter|useParams|URLSearchParams|location\.|history\.(?:push|replace)State|"use server"|gtag|localStorage|sessionStorage|indexedDB|document\.cookie|window\.open|new Image|<form|name=/
      );
    }
    for (const file of files.filter((each) => each.startsWith("src/components/payout-check/") || each.startsWith("src/app/"))) {
      expect(source(file), file).not.toMatch(/\bVND\b|\b(?:safe|cleared|verified|compliant)\b/);
    }
    // Recording where a workspace came from is the shared start button's, outside these files (CP13).
    expect(source("src/app/check-payouts/page.tsx")).not.toContain("data-cta");
    for (const file of files.filter((each) => !each.startsWith("src/app/"))) expect(source(file), file).not.toMatch(/ToolCta|ToolStartLink|free-tools/);
  });
});
