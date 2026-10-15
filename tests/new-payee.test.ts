import { describe, expect, it } from "vitest";
import { addressGiver, addressProvenance, membersLeftOut, MIRROR, newPayeeCheck, newPayeeObserved, newPayeeSelfMessage, PAYEE } from "@/lib/new-payee";

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

  it("passes the payee's address a member other than whoever asked for it confirmed", () => {
    const entries = [
      confirmed(BAO, ADDRESS),
      changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }),
      { action: "payee_link_created", detail: { by: ANNA, counterpartyId: "cp-1", linkId: "link-1" } },
    ];
    expect(newPayeeCheck({ address: ADDRESS, paidTo: paid(), entries })).toEqual({ firstPayment: true, addressBy: PAYEE, linkCreatedBy: ANNA, confirmedBy: BAO, twoParties: true });
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
 * An address the payee sent (independent review, 2026-10-15): the payee typed it, but a member asked for it, so that
 * member counts as having given it. Otherwise one admin could create a payee link, or have a GitHub bounty act as them,
 * send their own wallet through it, confirm it, and the agent would make the first payment with no second person.
 * Who asked is read from the workspace's own signed entries: `payee_link_created` for a link, `github_bounty_attached`
 * for the pull request a `/payto` was posted on. When no one can be named, the payment waits for a person.
 */
describe("an address sent through a payee link, and the member who created the link", () => {
  const LINK = "link-1";
  const sent = changed(null, ADDRESS, { via: "payee_link", linkId: LINK });
  const linkCreated = (by: string, linkId = LINK) => ({ action: "payee_link_created", detail: { by, counterpartyId: "cp-1", linkId } });
  // The link's own row, read only when its signed entry is missing (tests/new-payee-facts.test.ts).
  const fromRow = (creator: string | null) => ({ ...sent, linkCreatedBy: creator });

  it("keeps the payee as who sent it, and names the member who created the link beside it, from the link's signed entry", () => {
    expect(addressProvenance(ADDRESS, [confirmed(ANNA, ADDRESS), sent, linkCreated(ANNA)])).toEqual({ addressBy: PAYEE, linkCreatedBy: ANNA, confirmers: [ANNA] });
  });

  it("holds the first payment when the member who created the link is the only one who confirmed the address", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), sent, linkCreated(ANNA)] })).toEqual({
      firstPayment: true,
      addressBy: PAYEE,
      linkCreatedBy: ANNA,
      confirmedBy: ANNA,
      twoParties: false,
    });
  });

  it("passes it when another member confirmed the address", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), sent, linkCreated(ANNA)] })).toEqual({
      firstPayment: true,
      addressBy: PAYEE,
      linkCreatedBy: ANNA,
      confirmedBy: BAO,
      twoParties: true,
    });
    // The creator confirming beside another member changes nothing: two people stand behind it.
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), confirmed(BAO, ADDRESS), sent, linkCreated(ANNA)] })).toMatchObject({
      confirmedBy: BAO,
      twoParties: true,
    });
  });

  it("believes the link's signed entry over its row, and reads the row only when the entry is missing", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), fromRow(BAO), linkCreated(ANNA)] })).toMatchObject({
      linkCreatedBy: ANNA,
      twoParties: false,
    });
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), fromRow(ANNA)] })).toMatchObject({
      linkCreatedBy: ANNA,
      twoParties: false,
    });
  });

  it("holds the first payment, whoever confirmed it, when no one can be named as the link's creator", () => {
    for (const entries of [
      [confirmed(BAO, ADDRESS), sent],
      [confirmed(BAO, ADDRESS), fromRow(null)],
      // Another link's entry names no one for this one.
      [confirmed(BAO, ADDRESS), sent, linkCreated(ANNA, "link-2")],
    ]) {
      const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries });
      expect(check).toEqual({ firstPayment: true, addressBy: PAYEE, confirmedBy: BAO, confirmersLeftOut: [BAO], twoParties: false });
      expect(addressGiver(check)).toBeNull();
      // Whoever confirmed it is left out of approving it: two different members stand behind its first payment.
      expect(membersLeftOut(check)).toEqual([BAO]);
    }
  });

  it("names nothing about a link for an address given any other way", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), changed(ANNA, ADDRESS)] })).not.toHaveProperty("linkCreatedBy");
  });
});

/**
 * A GitHub login is tied to no member (independent review, 2026-10-15, round 2): every `/bounty` acts as the member who
 * connected GitHub, whoever typed it. So for an address sent with `/payto`, no confirmation counts as a second person:
 * the agent holds its first payment, and whoever confirmed it is left out of approving it with whoever the bounty acts
 * as. A bounty its own pull request's author typed names no one.
 */
describe("an address sent with /payto on a GitHub pull request, and the member its bounty acts as", () => {
  const PULL = "https://github.com/acme/app/pull/42";
  const payto = changed(null, ADDRESS, { via: "github", installationId: 7, login: "octocat", commentUrl: `${PULL}#issuecomment-9001` });
  const bounty = (by: string, pullRequest = PULL, typedBy = "maintainer") => ({
    action: "github_bounty_attached",
    detail: { by, via: "github", pullRequest, login: typedBy, author: "octocat", milestoneId: "ms-1", counterpartyId: "cp-1", commentUrl: `${pullRequest}#issuecomment-1` },
  });

  it("names the member the pull request's bounty acts as, from the bounty's signed entry", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(ANNA, ADDRESS), payto, bounty(ANNA)] })).toEqual({
      firstPayment: true,
      addressBy: PAYEE,
      bountyBy: ANNA,
      confirmedBy: ANNA,
      twoParties: false,
    });
  });

  it("never counts a member's confirmation as the second person, and leaves whoever confirmed it out of approving it", () => {
    const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), payto, bounty(ANNA)] });
    expect(check).toEqual({ firstPayment: true, addressBy: PAYEE, bountyBy: ANNA, confirmedBy: BAO, confirmersLeftOut: [BAO], twoParties: false });
    expect(membersLeftOut(check)).toEqual([ANNA, BAO]);
  });

  it("reads the bounty on the pull request the address was posted on, not another one for the same payee", () => {
    const entries = [confirmed(BAO, ADDRESS), payto, bounty(BAO, "https://github.com/acme/app/pull/7"), bounty(ANNA)];
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries })).toMatchObject({ bountyBy: ANNA, twoParties: false });
  });

  it("names no one for a bounty its pull request's own author typed, a self-bounty", () => {
    const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), payto, bounty(ANNA, PULL, "OctoCat")] });
    expect(check).toEqual({ firstPayment: true, addressBy: PAYEE, confirmedBy: BAO, confirmersLeftOut: [BAO], twoParties: false });
    expect(addressGiver(check)).toBeNull();
    expect(membersLeftOut(check)).toEqual([BAO]);
  });

  it("holds the first payment, and leaves whoever confirmed it out, when no bounty on that pull request names a member", () => {
    for (const entries of [[confirmed(BAO, ADDRESS), payto], [confirmed(BAO, ADDRESS), payto, bounty(ANNA, "https://github.com/acme/app/pull/7")]]) {
      const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries });
      expect(check).toEqual({ firstPayment: true, addressBy: PAYEE, confirmedBy: BAO, confirmersLeftOut: [BAO], twoParties: false });
      expect(addressGiver(check)).toBeNull();
      expect(membersLeftOut(check)).toEqual([BAO]);
    }
  });

  it("names the member who added a counterparty from GitHub with its address, and holds its first payment", () => {
    expect(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), created(ANNA, ADDRESS, { via: "github" })] })).toMatchObject({
      addressBy: PAYEE,
      bountyBy: ANNA,
      confirmersLeftOut: [BAO],
      twoParties: false,
    });
  });
});

describe("membersLeftOut and newPayeeSelfMessage: who may not approve a first payment alone, and why", () => {
  it("is whoever gave the address when a member answers for it, and adds whoever confirmed it when none does", () => {
    const linked = [confirmed(BAO, ADDRESS), changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }), { action: "payee_link_created", detail: { by: ANNA, linkId: "link-1" } }];
    const anchored = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: linked });
    expect(anchored).not.toHaveProperty("confirmersLeftOut");
    expect(membersLeftOut(anchored)).toEqual([ANNA]);
    // An address a script wrote, with no giver known.
    const unknown = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), changed(null, ADDRESS)] });
    expect(unknown).toMatchObject({ addressBy: null, confirmersLeftOut: [BAO], twoParties: false });
    expect(membersLeftOut(unknown)).toEqual([BAO]);
    expect(membersLeftOut(null)).toEqual([]);
  });

  it("tells whoever confirmed an address no member answers for that someone else approves its first payment", () => {
    const unknown = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" })] });
    expect(newPayeeSelfMessage(unknown, BAO)).toBe("You confirmed this address, so someone else must approve its first payment.");
    const typed = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [created(ANNA, ADDRESS)] });
    expect(newPayeeSelfMessage(typed, ANNA)).toBe("You gave this payee's address, so someone else must approve its first payment.");
  });
});

describe("addressGiver: the member a first payment's approval must not rest on alone", () => {
  it("is the member who asked for an address the payee sent, and whoever gave it otherwise", () => {
    const linked = [changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }), { action: "payee_link_created", detail: { by: ANNA, linkId: "link-1" } }];
    expect(addressGiver(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: linked }))).toBe(ANNA);
    expect(addressGiver(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [created(BAO, ADDRESS)] }))).toBe(BAO);
    expect(addressGiver(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [created(BAO, ADDRESS, { via: "mirror" })] }))).toBe(MIRROR);
    expect(addressGiver(null)).toBeNull();
  });
});

describe("newPayeeObserved: what a decision on a first payment records (N6)", () => {
  it("records who gave the address, who confirmed it and whether two parties stand behind it, as before", () => {
    const check = newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: [confirmed(BAO, ADDRESS), changed(ANNA, ADDRESS)] });
    expect(newPayeeObserved(check!)).toEqual({ addressBy: ANNA, confirmedBy: BAO, twoParties: true });
  });

  it("records the member who asked for an address beside the payee who sent it", () => {
    const linked = [confirmed(ANNA, ADDRESS), changed(null, ADDRESS, { via: "payee_link", linkId: "link-1" }), { action: "payee_link_created", detail: { by: ANNA, linkId: "link-1" } }];
    expect(newPayeeObserved(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: linked })!)).toEqual({
      addressBy: PAYEE,
      linkCreatedBy: ANNA,
      confirmedBy: ANNA,
      twoParties: false,
    });
    const payto = [
      confirmed(BAO, ADDRESS),
      changed(null, ADDRESS, { via: "github", commentUrl: "https://github.com/acme/app/pull/42#issuecomment-9" }),
      { action: "github_bounty_attached", detail: { by: ANNA, pullRequest: "https://github.com/acme/app/pull/42" } },
    ];
    expect(newPayeeObserved(newPayeeCheck({ address: ADDRESS, paidTo: new Set(), entries: payto })!)).toEqual({
      addressBy: PAYEE,
      bountyBy: ANNA,
      confirmedBy: BAO,
      twoParties: false,
    });
  });
});
