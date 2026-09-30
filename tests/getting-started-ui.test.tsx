import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { gettingStarted, type GettingStartedInput } from "@/lib/getting-started";

/** The Get started checklist as the markup it renders on the server, and how the console wires it. */

function checklist(overrides: Partial<GettingStartedInput> = {}) {
  return gettingStarted({
    mode: "sandbox",
    accounts: [{ kind: "operating", circle_wallet_id: null, balance: 0 }],
    counterparties: [],
    invoiceCount: 0,
    ...overrides,
  });
}

const render = (props: { isOwner?: boolean } & Partial<GettingStartedInput> = {}) => {
  const { isOwner = true, ...input } = props;
  return renderToStaticMarkup(<GettingStarted slug="acme" checklist={checklist(input)} isOwner={isOwner} />);
};

describe("GettingStarted", () => {
  it("lists the five steps, counts the done ones, and links the guide", () => {
    const markup = render({ counterparties: [{ address: "0x1948aB0000000000000000000000000000c345a0" }] });
    expect(markup).toContain("Get started");
    expect(markup).toContain("1 of 5 done");
    for (const title of ["Add a wallet", "Fund it with USDC", "Add a counterparty with an Arc address", "Add an invoice", "Go live"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain('href="/docs/guides/go-live"');
    expect(markup).toContain("(done)");
  });

  it("marks and links only the next step", () => {
    const markup = render();
    expect(markup.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markup).toContain('href="/o/acme/settings#go-live-title"');
    expect(markup).toContain(">Start<");
  });

  it("links the next step's own page once the wallet is funded", () => {
    const markup = render({ accounts: [{ kind: "operating", circle_wallet_id: "w-1", balance: 40 }] });
    expect(markup).toContain('href="/o/acme/counterparties"');
    expect(markup).not.toContain('href="/o/acme/settings#go-live-title"');
  });

  it("tells an admin that an owner takes the owner-only steps", () => {
    const markup = render({ isOwner: false });
    expect(markup).toContain("An owner of this workspace does this step.");
    expect(markup).toContain(">View<");
  });

  it("renders nothing once the workspace is live", () => {
    expect(render({ mode: "live" })).toBe("");
  });
});

describe("the console's checklist", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "console", "page.tsx"), "utf8");

  it("is only computed for people who may add records", () => {
    expect(page).toMatch(/const checklist = can\(role, "records\.write"\)\s*\?\s*gettingStarted\(/);
  });

  it("uses the rows the console already reads, with no extra query", () => {
    expect(page).toContain("gettingStarted({ mode: access.membership.mode, accounts: accountsRows, counterparties, invoiceCount: invoices.length })");
  });
});
