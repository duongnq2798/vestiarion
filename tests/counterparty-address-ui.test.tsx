import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CounterpartyAddress, { type CounterpartyAddressProps } from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyLimitEdit from "@/components/intake/CounterpartyLimitEdit";

/**
 * The address controls on a counterparty card, rendered to static markup:
 * who sees Edit address and Confirm address, and what the card says while a
 * changed address waits for a person.
 */

vi.mock("@/app/actions/intake", () => ({
  updateCounterpartyAddressAction: vi.fn(),
  confirmCounterpartyAddressAction: vi.fn(),
  updateCounterpartyLimitAction: vi.fn(),
}));

const html = (node: ReactElement) => renderToStaticMarkup(node);
const ADDRESS = "0x2222222222222222222222222222222222222222";

function render(props: Partial<CounterpartyAddressProps> = {}) {
  return html(
    <CounterpartyAddress
      orgSlug="acme"
      counterparty={{ id: "1b6c1c9e-4a4f-4a7e-9b1e-0000000000c7", name: "Acme", address: ADDRESS }}
      unconfirmedSince={null}
      canWrite={false}
      canConfirm={false}
      {...props}
    />
  );
}

describe("CounterpartyAddress", () => {
  it("shows the address, and no controls, to someone who may do neither", () => {
    const markup = render({ unconfirmedSince: "2026-09-30T12:00:00Z" });
    expect(markup).toContain(ADDRESS);
    expect(markup).not.toContain("Edit address");
    expect(markup).not.toContain("Confirm address");
    // The waiting state is shown to everyone: it explains why payments are held.
    expect(markup).toContain("Changed 2026-09-30 · not yet confirmed");
  });

  it("offers Edit address to an owner or admin", () => {
    expect(render({ canWrite: true })).toContain("Edit address");
  });

  it("says when there is no address", () => {
    expect(render({ counterparty: { id: "x", name: "Acme", address: null } })).toContain("No payment address");
  });

  it("offers Confirm address only while a change is unconfirmed, posting the address shown", () => {
    expect(render({ canConfirm: true })).not.toContain("Confirm address");

    const markup = render({ canConfirm: true, unconfirmedSince: "2026-09-30T12:00:00Z" });
    expect(markup).toContain("Confirm address");
    expect(markup).toMatch(new RegExp(`<input type="hidden" name="address" value="${ADDRESS}"/>`));
  });

  it("shows nothing about confirming for an address that was never changed", () => {
    const markup = render({ canWrite: true, canConfirm: true });
    expect(markup).not.toContain("not yet confirmed");
  });
});

describe("CounterpartyLimitEdit", () => {
  it("offers Edit limit, named for the counterparty for a screen reader", () => {
    const markup = html(
      <CounterpartyLimitEdit orgSlug="acme" counterparty={{ id: "c1", name: "Centronex", role: "vendor", baselineLimit: 2 }} />
    );
    expect(markup).toContain("Edit limit");
    expect(markup).toContain('aria-label="Edit Centronex&#x27;s payment limit"');
  });
});

describe("the Counterparties page", () => {
  const page = readFileSync(path.join(process.cwd(), "src", "app", "o", "[slug]", "counterparties", "page.tsx"), "utf8");

  it("offers Edit limit only to people who may add records", () => {
    expect(page).toMatch(/\{canWrite && \(\s*<CounterpartyLimitEdit/);
  });
});
