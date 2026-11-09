import { describe, expect, it } from "vitest";
import {
  COUNTERPARTY_SECTIONS,
  counterpartyIdOf,
  counterpartyPath,
  counterpartyRowPath,
  milestoneAnchor,
  milestoneRowPath,
} from "@/lib/counterparty-paths";
import { orgHref } from "@/lib/auth/org-paths";

/**
 * The paths to a counterparty's page and to a milestone's row (docs/superpowers/specs/2026-11-09-counterparty-page-design.md
 * CL1, CL2, CL15, CL16): every "fix it" link, the evidence page and the emails build them here.
 */

const ID = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";

describe("counterparty paths", () => {
  it("CL1: names the page's parts in the order it shows them, Profile's lines inside Profile", () => {
    expect(COUNTERPARTY_SECTIONS).toEqual([
      "profile",
      "screening",
      "limit",
      "billing-email",
      "purchase-orders",
      "address",
      "payee-link",
      "milestones",
      "bills",
      "payments",
      "documents",
      "history",
    ]);
    // Each is an id once, and a plain one: lowercase words and dashes.
    expect(new Set(COUNTERPARTY_SECTIONS).size).toBe(COUNTERPARTY_SECTIONS.length);
    for (const section of COUNTERPARTY_SECTIONS) expect(section).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  it("CL15: opens a counterparty's page, at the part a link names", () => {
    expect(counterpartyPath(ID)).toBe(`/counterparties/${ID}`);
    expect(counterpartyPath(ID, "address")).toBe(`/counterparties/${ID}#address`);
    expect(counterpartyPath(ID, "billing-email")).toBe(`/counterparties/${ID}#billing-email`);
    expect(orgHref("acme", counterpartyPath(ID, "limit"))).toBe(`/o/acme/counterparties/${ID}#limit`);
  });

  it("CL15: gives the Counterparties list for no id", () => {
    expect(counterpartyPath("")).toBe("/counterparties");
    expect(counterpartyPath("", "address")).toBe("/counterparties");
  });

  it("CL15: keeps an id that is not a UUID inside its own path segment", () => {
    expect(counterpartyPath("cp-1", "limit")).toBe("/counterparties/cp-1#limit");
    expect(counterpartyPath("../settings#x")).toBe("/counterparties/..%2Fsettings%23x");
  });

  it("CL16: opens the counterparty's row on the list, as old bookmarks do", () => {
    expect(counterpartyRowPath(ID)).toBe(`/counterparties#counterparty-${ID}`);
  });

  it("CL2: takes a UUID, lowercased, and nothing else", () => {
    expect(counterpartyIdOf(ID)).toBe(ID);
    expect(counterpartyIdOf(ID.toUpperCase())).toBe(ID);
    for (const param of ["", "cp-1", `${ID} `, ` ${ID}`, `${ID}x`, ID.slice(1), ID.replace(/-/g, ""), "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4g", `${ID}/x`]) {
      expect(counterpartyIdOf(param), param).toBeNull();
    }
  });

  it("CL15: opens a milestone's row on Contractors, and a paid one under Show all", () => {
    expect(milestoneAnchor(ID)).toBe(`milestone-${ID}`);
    expect(milestoneRowPath(ID, { paid: false })).toBe(`/contractors#milestone-${ID}`);
    expect(milestoneRowPath(ID, { paid: true })).toBe(`/contractors?history=all#milestone-${ID}`);
  });
});
