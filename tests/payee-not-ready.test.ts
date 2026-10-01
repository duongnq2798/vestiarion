import { describe, expect, it } from "vitest";
import { payeeNotReady } from "@/lib/counterparty-address";

/**
 * Whether the agent can pay a contractor yet (pay a freelancer R5): in a live
 * workspace a contractor with no address, or with an address a person changed
 * and no one has confirmed, waits; a sandbox simulates a payment to one with
 * no address, as it always has.
 */

const confirmed = { address: "0x1111111111111111111111111111111111111111", address_changed_at: null, address_confirmed_at: null };

describe("payeeNotReady", () => {
  it("is ready with an address no one changed since it was confirmed", () => {
    expect(payeeNotReady(confirmed, true)).toBeNull();
    expect(
      payeeNotReady({ ...confirmed, address_changed_at: "2026-10-01T10:00:00Z", address_confirmed_at: "2026-10-01T10:05:00Z" }, true)
    ).toBeNull();
  });

  it("waits in a live workspace for a payee who has not added an address yet", () => {
    expect(payeeNotReady({ ...confirmed, address: null }, true)).toBe("no_address");
  });

  it("pays a sandbox payee with no address, simulated", () => {
    expect(payeeNotReady({ ...confirmed, address: null }, false)).toBeNull();
  });

  it("waits, live or not, for someone to confirm an address a person changed", () => {
    const changed = { ...confirmed, address_changed_at: "2026-10-01T10:00:00Z" };
    expect(payeeNotReady(changed, true)).toBe("unconfirmed");
    expect(payeeNotReady(changed, false)).toBe("unconfirmed");
    expect(payeeNotReady({ ...changed, address_confirmed_at: "2026-10-01T09:00:00Z" }, true)).toBe("unconfirmed");
  });
});
