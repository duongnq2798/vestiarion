import { describe, expect, it } from "vitest";
import { addressGiver, addressProvenance, MIRROR, newPayeeCheck, newPayeeObserved, PAYEE } from "@/lib/new-payee";

/**
 * Two people before the first payment to an address (docs/superpowers/specs/2026-10-05-new-payee-check-design.md
 * N1–N3): whether a payment is the first to an address, who gave the address and who confirmed it, read from the
 * counterparty's ledger entries newest first, and whether two different parties stand behind it. Pure.
 */

const ADDRESS = "0x2222222222222222222222222222222222222222";
const OTHER = "0x3333333333333333333333333333333333333333";
const ANNA = "member-anna";
const BAO = "member-bao";

const created = (by: string | null, address: string | null, extra: Record<string, unknown> = {}) => ({
  action: "create_counterparty",
  detail: { by, counterpartyId: "cp-1", address, ...extra },
});
const changed = (by: string | null, to: string | null, extra: Record<string, unknown> = {}) => ({
  action: "counterparty_address_changed",
  detail: { by, counterpartyId: "cp-1", from: null, to, ...extra },
});
const confirmed = (by: string, address: string) => ({ action: "counterparty_address_confirmed", detail: { by, counterpartyId: "cp-1", address, via: "confirm" } });

describe("addressProvenance: who gave the address and who confirmed it (N2)", () => {
  it("names the member who typed it into the console when the counterparty was added", () => {
    expect(addressProvenance(ADDRESS, [created(ANNA, ADDRESS)])).toEqual({ addressBy: ANNA, confirmers: [] });
  });

  it("names the payee for an address sent through a payee link or GitHub, and the members who confirmed it since", () => {
    expect(addressProvenance(ADDRESS, [confirmed(BAO, ADDRESS), changed(null, ADDRESS, { via: "payee_link" }), created(ANNA, null)])).toEqual({
      addressBy: PAYEE,
      confirmers: [BAO],
    });
    expect(addressProvenance(ADDRESS, [changed(null, ADDRESS, { via: "github" })]).addressBy).toBe(PAYEE);
    expect(addressProvenance(ADDRESS, [created(ANNA, ADDRESS, { via: "github" })]).addressBy).toBe(PAYEE);
  });

  it("reads the newest entry that set the address, and only confirmations after it, matching case-insensitively", () => {
    const entries = [
      confirmed(BAO, ADDRESS.toUpperCase().replace("0X", "0x")),
      changed(ANNA, ADDRESS),
      confirmed(BAO, OTHER),
      changed(BAO, OTHER),
      created(ANNA, null),
    ];
    expect(addressProvenance(ADDRESS, entries)).toEqual({ addressBy: ANNA, confirmers: [BAO] });
  });

  it("knows no giver for a change with no member and no payee route", () => {
    expect(addressProvenance(ADDRESS, [changed(null, ADDRESS)]).addressBy).toBeNull();
  });

  it("knows no giver for an address no entry set, as a script that wrote it directly", () => {
    expect(addressProvenance(ADDRESS, [created(ANNA, OTHER)])).toEqual({ addressBy: null, confirmers: [] });
    expect(addressProvenance(ADDRESS, [])).toEqual({ addressBy: null, confirmers: [] });
  });
});

describe("newPayeeCheck: two parties before the first payment (N1, N3)", () => {
  const paid = (...addresses: string[]) => new Set(addresses.map((address) => address.toLowerCase()));

  it("is no first payment once the address has received a confirmed one, however it is written", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: paid(ADDRESS.toUpperCase().replace("0X", "0x")), entries: [created(ANNA, ADDRESS)] })).toEqual({
      firstPayment: false,
      addressBy: ANNA,
      confirmedBy: null,
      twoParties: true,
    });
  });

  it("passes the payee's address a member confirmed", () => {
    const check = newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries: [confirmed(BAO, ADDRESS), changed(null, ADDRESS, { via: "payee_link" })] });
    expect(check).toEqual({ firstPayment: true, addressBy: PAYEE, confirmedBy: BAO, twoParties: true });
  });

  it("passes a member's address another member confirmed", () => {
    const check = newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries: [confirmed(BAO, ADDRESS), changed(ANNA, ADDRESS)] });
    expect(check).toMatchObject({ firstPayment: true, addressBy: ANNA, confirmedBy: BAO, twoParties: true });
  });

  it("holds an address one member typed in, alone or confirmed by themselves", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries: [created(ANNA, ADDRESS)] })).toEqual({
      firstPayment: true,
      addressBy: ANNA,
      confirmedBy: null,
      twoParties: false,
    });
    expect(newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries: [confirmed(ANNA, ADDRESS), changed(ANNA, ADDRESS)] })).toMatchObject({
      confirmedBy: ANNA,
      twoParties: false,
    });
  });

  it("holds a payee's address no member has confirmed, and an address with no known giver", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries: [changed(null, ADDRESS, { via: "payee_link" })] })?.twoParties).toBe(false);
    expect(newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries: [confirmed(BAO, ADDRESS)] })).toMatchObject({ addressBy: null, twoParties: false });
  });

  it("asks nothing of a counterparty with no address", () => {
    expect(newPayeeCheck({ address: null, paidTo: paid(), entries: [] })).toBeNull();
  });
});

describe("a mirror address Vestiarion made for a payee in shadow mode (shadow mode S7)", () => {
  const mirrored = changed(ANNA, ADDRESS, { via: "mirror", walletId: "wallet-1" });

  it("is given by Vestiarion itself, not by the member who asked for it", () => {
    expect(addressProvenance(ADDRESS, [mirrored])).toEqual({ addressBy: MIRROR, confirmers: [] });
  });

  it("has two parties behind its first payment: no outsider could have given it", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [mirrored] })).toEqual({
      firstPayment: true,
      addressBy: MIRROR,
      confirmedBy: null,
      twoParties: true,
    });
  });

  it("stands behind no other address set over it since", () => {
    expect(newPayeeCheck({ address: OTHER, paidTo: new Set(), entries: [changed(BAO, OTHER), mirrored] })?.twoParties).toBe(false);
  });
});

/**
 * An address sent through a payee link (independent review, 2026-10-15): the payee typed it, but a member chose to ask
 * for it, so that member counts as having given it. Without this, one admin could create a link, send their own wallet
 * through it, confirm it, and the agent would make the first payment with no second person. `linkCreatedBy` is read
 * from the link itself when the facts are loaded (tests/new-payee-facts.test.ts), never from the ledger entry.
 */
describe("an address sent through a payee link, and the member who created the link", () => {
  const linked = (creator: string | null) => ({ ...changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }), linkCreatedBy: creator });

  it("keeps the payee as who sent it, and names the member who created the link beside it", () => {
    expect(addressProvenance(ADDRESS, [confirmed(ANNA, ADDRESS), linked(ANNA)])).toEqual({ addressBy: PAYEE, linkCreatedBy: ANNA, confirmers: [ANNA] });
  });

  it("holds the first payment when the member who created the link is the only one who confirmed the address", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), linked(ANNA)] })).toEqual({
      firstPayment: true,
      addressBy: PAYEE,
      linkCreatedBy: ANNA,
      confirmedBy: ANNA,
      twoParties: false,
    });
  });

  it("passes it when another member confirmed the address", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), linked(ANNA)] })).toEqual({
      firstPayment: true,
      addressBy: PAYEE,
      linkCreatedBy: ANNA,
      confirmedBy: BAO,
      twoParties: true,
    });
    // The creator confirming beside another member changes nothing: two people stand behind it.
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), confirmed(BAO, ADDRESS), linked(ANNA)] })).toMatchObject({
      confirmedBy: BAO,
      twoParties: true,
    });
  });

  it("reads a link whose creator is not known, an account deleted since, as the payee's alone, as before", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), linked(null)] })).toEqual({
      firstPayment: true,
      addressBy: PAYEE,
      confirmedBy: BAO,
      twoParties: true,
    });
  });

  it("names nothing about a link for an address given any other way", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), changed(ANNA, ADDRESS)] })).not.toHaveProperty("linkCreatedBy");
  });
});

describe("addressGiver: the member a first payment's approval must not rest on alone", () => {
  it("is the member who created the link for an address sent through one, and whoever gave it otherwise", () => {
    const linked = { ...changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }), linkCreatedBy: ANNA };
    expect(addressGiver(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [linked] }))).toBe(ANNA);
    expect(addressGiver(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [created(BAO, ADDRESS)] }))).toBe(BAO);
    expect(addressGiver(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [changed(null, ADDRESS, { via: "github" })] }))).toBe(PAYEE);
    expect(addressGiver(null)).toBeNull();
  });
});

describe("newPayeeObserved: what a decision on a first payment records (N6)", () => {
  it("records who gave the address, who confirmed it and whether two parties stand behind it, as before", () => {
    const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), changed(ANNA, ADDRESS)] });
    expect(newPayeeObserved(check!)).toEqual({ addressBy: ANNA, confirmedBy: BAO, twoParties: true });
  });

  it("records the member who created the payee link beside the payee who sent the address through it", () => {
    const linked = { ...changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }), linkCreatedBy: ANNA };
    const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), linked] });
    expect(newPayeeObserved(check!)).toEqual({ addressBy: PAYEE, linkCreatedBy: ANNA, confirmedBy: ANNA, twoParties: false });
  });
});
