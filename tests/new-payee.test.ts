import { describe, expect, it } from "vitest";
import { addressProvenance, MIRROR, newPayeeCheck, PAYEE } from "@/lib/new-payee";

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
