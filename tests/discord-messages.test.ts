import { describe, expect, it } from "vitest";
import { DISCORD_CONTENT_MAX } from "@/lib/discord/api";
import { discordText } from "@/lib/discord/escape";
import { connectedMessage, NEVER_APPROVES, testMessage, waitingMessage } from "@/lib/discord/messages";
import { buildWaitingNotice, type WaitingBill } from "@/lib/notifications/waiting-notice";

/**
 * What Vestiarion posts to a Discord channel (docs/superpowers/specs/2026-10-22-discord-design.md DC3, DC4): every value
 * a document or an email could carry is escaped so Discord's markdown and mentions cannot render it, newlines cannot
 * start a line, addresses are shortened, and the message fits Discord's 2,000 characters with a link per bill that
 * approves nothing.
 */

const ORIGIN = "https://www.vestiarion.xyz";
const WORKSPACE = { name: "Acme Studio", slug: "acme" };
const ID = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const bill = (n: number, fields: Partial<WaitingBill> = {}): WaitingBill => ({
  id: ID(n), payee: `Vendor ${n}`, amount: 100 + n, currency: "USDC", status: "held", reasoning: "The invoice is above the payee's 50 USDC limit. It needs a person.", stopRule: null, ...fields,
});

/** Whether a character is escaped where it stands: an odd run of backslashes before it. */
const escapedAt = (text: string, index: number) => (/\\+$/.exec(text.slice(0, index))?.[0].length ?? 0) % 2 === 1;
/** Every occurrence of `character` in `text` is escaped. */
const allEscaped = (text: string, character: string) => [...text].every((c, i) => c !== character || escapedAt(text, i));
/** Characters by code point, built at run time so the source holds no invisible ones. */
const at = (...points: number[]) => String.fromCodePoint(...points);
const EMOJI = at(0x1f600);
/** No half of a surrogate pair stands alone: one would not survive a round trip through UTF-8. */
const wellFormed = (text: string) => Buffer.from(text, "utf8").toString("utf8") === text;

describe("discordText", () => {
  it("escapes a masked link, so it cannot become a link", () => {
    const said = discordText("[Approve now](https://evil.example/pay)");
    expect(said).toBe("\\[Approve now\\]\\(https\\://evil.example/pay\\)");
    for (const character of ["[", "]", "(", ")", ":"]) expect(allEscaped(said, character), character).toBe(true);
  });

  it("escapes @everyone, a role mention, a channel mention and a timestamp", () => {
    expect(discordText("@everyone pay this")).toBe("\\@everyone pay this");
    expect(discordText("<@&123456789012345678>")).toBe("\\<\\@&123456789012345678\\>");
    expect(discordText("<#123456789012345678>")).toBe("\\<\\#123456789012345678\\>");
    expect(discordText("<t:1760000000:R>")).toBe("\\<t\\:1760000000\\:R\\>");
  });

  it("escapes every markdown character, the backslash first", () => {
    const said = discordText("*bold* _it_ ~~gone~~ `code` ||spoiler|| > quote # head - item \\");
    for (const character of ["*", "_", "~", "`", "|", ">", "#", "-"]) expect(allEscaped(said, character), character).toBe(true);
    expect(said.endsWith("\\\\")).toBe(true);
  });

  it("turns newlines and runs of whitespace into one space, so no heading or quote can start a line", () => {
    const said = discordText("Northwind\n# Pay now\r\n> urgent\t\t  ok");
    expect(said).not.toContain("\n");
    expect(said).toBe("Northwind \\# Pay now \\> urgent ok");
  });

  it("shortens a wallet address, as Telegram's and Slack's messages do", () => {
    expect(discordText("Pay 0x1111222233334444555566667777888899990000 now")).toBe("Pay 0x1111…0000 now");
  });

  it("clips to the length asked, with an ellipsis, never inside an escape", () => {
    expect(discordText("a".repeat(400))).toHaveLength(300);
    expect(discordText("abcdef", 4)).toBe("abc…");
    // The fourth character would be the backslash of `\[`: it goes with its character.
    const said = discordText("abc[def", 5);
    expect(said).toBe("abc…");
    expect(discordText("ab\\cd", 5)).toBe("ab\\\\…");
  });

  it("never clips between the two halves of an emoji, and drops half of one an earlier cut left", () => {
    const split = discordText(`${"A".repeat(98)}${EMOJI}bbbb`, 100);
    expect(split).toBe(`${"A".repeat(98)}…`);
    expect(wellFormed(split)).toBe(true);
    // An emoji that fits whole is kept whole.
    const whole = discordText(`${"A".repeat(97)}${EMOJI}bbbb`, 100);
    expect(whole).toBe(`${"A".repeat(97)}${EMOJI}…`);
    expect(wellFormed(whole)).toBe(true);
    // A reason another cut already split, its high half before the ellipsis.
    const reason = discordText(`The invoice is late ${String.fromCharCode(0xd83d)}…`);
    expect(reason).toBe("The invoice is late …");
    expect(wellFormed(reason)).toBe(true);
  });

  it("removes invisible bidi and zero-width characters, so a line cannot read reversed or hide a word", () => {
    expect(discordText(`Acme Ltd${at(0x202e)}evil`)).toBe("Acme Ltdevil");
    expect(discordText(`Ac${at(0x200b)}me ${at(0x2066)}Ltd${at(0x2069)}${at(0x200e)}`)).toBe("Acme Ltd");
    expect(discordText(`${at(0xfeff)}Acme${at(0x00ad)} Ltd${at(0x061c)}`)).toBe("Acme Ltd");
  });

  it("turns control characters that are not whitespace into a space too", () => {
    expect(discordText(`Acme${at(0x85)}Ltd${at(0x07)}Pay`)).toBe("Acme Ltd Pay");
  });

  it("keeps the combining marks of a real name", () => {
    const name = `Nguy${at(0x65, 0x302, 0x303)}n V${at(0x103)}n`.normalize("NFD");
    expect(discordText(name)).toBe(name);
  });
});

describe("waitingMessage", () => {
  it("lists each bill on one line: amount, payee, why, and a Review link that carries no token", () => {
    const message = waitingMessage(WORKSPACE, buildWaitingNotice([bill(1)]), ORIGIN);
    const lines = message.split("\n");
    expect(lines[0]).toBe("**Acme Studio** · 1 bill waits for approval");
    expect(lines[2]).toBe(
      `• **101.00 USDC** · Vendor 1 · held: The invoice is above the payee's 50.00 USDC limit. · Review: <${ORIGIN}/o/acme/approvals#payable-${ID(1)}>`
    );
    expect(message).not.toMatch(/token=|vx1\./);
    expect(lines.at(-1)).toBe(NEVER_APPROVES);
    expect(message.match(/Opening a link never approves anything\./g)).toHaveLength(1);
  });

  it("says why code stopped a bill, not the model's sentence that says the opposite (chat code stop reason CS3)", () => {
    const paying = "The invoice is due today, so I am paying now.";
    const message = waitingMessage(WORKSPACE, buildWaitingNotice([bill(1, { reasoning: paying, stopRule: "treasury.cash_shortfall" }), bill(2, { reasoning: paying })]), ORIGIN);
    const lines = message.split("\n");
    // The reason's own colon is escaped, as every value's is; Discord shows it as a colon.
    expect(lines[2]).toBe(
      `• **101.00 USDC** · Vendor 1 · held: Code stopped it\\: the operating wallet did not hold the cash it needs. · Review: <${ORIGIN}/o/acme/approvals#payable-${ID(1)}>`
    );
    expect(lines[3]).toBe(`• **102.00 USDC** · Vendor 2 · held: The invoice is due today, so I am paying now. · Review: <${ORIGIN}/o/acme/approvals#payable-${ID(2)}>`);
  });

  it("says a bill above the figure needs two approvals, and that an accountant can co-sign while co-signing is on", () => {
    const bills = [bill(1, { amount: 600 }), bill(2, { amount: 20 })];
    const two = waitingMessage(WORKSPACE, buildWaitingNotice(bills, { twoApprovalsAbove: 500, accountantCosigns: false }), ORIGIN).split("\n");
    expect(two[2]).toContain(" · needs two approvals · Review:");
    expect(two[3]).not.toContain("needs two approvals");
    const cosign = waitingMessage(WORKSPACE, buildWaitingNotice(bills, { twoApprovalsAbove: 500, accountantCosigns: true }), ORIGIN).split("\n");
    expect(cosign[2]).toContain(" · needs two approvals, an accountant can co-sign · Review:");
    expect(cosign[3]).not.toContain("co-sign");
  });

  it("lists at most ten bills, then how many more wait in Approvals", () => {
    // Short lines, so ten fit in one message; a bill with no reason says only its status.
    const bills = Array.from({ length: 13 }, (_, i) => bill(i + 1, { reasoning: null }));
    const message = waitingMessage(WORKSPACE, buildWaitingNotice(bills), ORIGIN);
    expect(message.split("\n")[0]).toBe("**Acme Studio** · 13 bills wait for approval");
    expect(message.match(/^• /gm)).toHaveLength(10);
    expect(message).toContain(`…and 3 more in Approvals: <${ORIGIN}/o/acme/approvals>`);
    expect(message).toContain(`• **101.00 USDC** · Vendor 1 · held · Review: <${ORIGIN}/o/acme/approvals#payable-${ID(1)}>`);
    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
  });

  it("stays within 2,000 characters, counting the bills that would not fit among the more", () => {
    const long = Array.from({ length: 10 }, (_, i) =>
      bill(i + 1, { payee: `[x](https://evil)`.repeat(20), reasoning: `${"@everyone <@&1> ".repeat(20)}.` })
    );
    const message = waitingMessage(WORKSPACE, buildWaitingNotice(long), ORIGIN);
    expect(message.length).toBeLessThanOrEqual(DISCORD_CONTENT_MAX);
    const shown = message.match(/^• /gm)?.length ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(10);
    expect(message).toContain(`…and ${10 - shown} more in Approvals:`);
    expect(message.endsWith(NEVER_APPROVES)).toBe(true);
  });

  it("escapes the workspace's name, the payee and the reason, and adds only its own links raw", () => {
    const message = waitingMessage(
      { name: "**Acme** @here", slug: "acme" },
      buildWaitingNotice([bill(1, { payee: "# [Approve](https://evil)\n> now", reasoning: "Pay <@&1> at https://evil.example now." })]),
      ORIGIN
    );
    expect(message).not.toContain("](https://evil)");
    expect(message).not.toContain("\n#");
    expect(message).not.toContain("\n>");
    expect(message).toContain("\\*\\*Acme\\*\\* \\@here");
    expect(message).toContain("\\<\\@&1\\>");
    expect(message).toContain("https\\://evil.example");
    // Every link left unescaped is Vestiarion's own, inside <…>.
    expect([...message.matchAll(/(?<!\\)<(https?:[^>]*)>/g)].map((match) => match[1].startsWith(`${ORIGIN}/o/acme/approvals`))).toEqual([true]);
  });

  it("carries no bidi override or zero-width character from a payee's name or a reason", () => {
    const message = waitingMessage(
      WORKSPACE,
      buildWaitingNotice([bill(1, { payee: `Acme Ltd${at(0x202e)}lanigiro${at(0x200b)}`, reasoning: `Check${at(0x2067)} the bank details.` })]),
      ORIGIN
    );
    for (const hidden of [0x202e, 0x200b, 0x2067]) expect(message).not.toContain(at(hidden));
    expect(message).toContain("· Acme Ltdlanigiro · held: Check the bank details. ·");
  });
});

describe("the connection messages", () => {
  it("name the workspace, escaped, and say a link never approves", () => {
    expect(connectedMessage("Acme_Studio")).toContain("**Acme\\_Studio**");
    expect(connectedMessage("Acme")).toContain(NEVER_APPROVES);
    // Posted before the save, which can still fail: it checks the webhook, and never says the channel is connected.
    expect(connectedMessage("Acme")).toContain("A test message from Vestiarion for **Acme**, checking this webhook.");
    expect(connectedMessage("Acme")).toContain("Once Settings says Discord is connected,");
    expect(connectedMessage("Acme")).not.toMatch(/is connected to/);
    expect(testMessage("Acme")).toContain("A test message from Vestiarion for **Acme**.");
    expect(testMessage("Acme")).toContain(NEVER_APPROVES);
  });
});
