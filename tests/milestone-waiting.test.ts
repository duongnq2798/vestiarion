import { describe, expect, it } from "vitest";
import { milestoneWaiting } from "@/lib/milestone-waiting";

/**
 * What a milestone's card on Contractors says it waits for, in the contractor stage's order (payee lock PL5;
 * pay a freelancer R5): the card must not say it waits while the agent pays it, nor say it is being decided while the
 * agent leaves it waiting.
 */

const NOW = Date.parse("2026-10-21T10:00:00Z");
const LOCK = { on: true, coolingHours: 24 };
const verified = { status: "verified", tx_ref: null };
const changed = { address: "0x1111111111111111111111111111111111111111", address_changed_at: "2026-10-21T08:00:00Z", address_confirmed_at: "2026-10-21T09:00:00Z" };
const options = { live: true, lock: LOCK, now: NOW };

describe("milestoneWaiting", () => {
  it("waits out the payee lock's wait on a confirmed, changed address, until the change plus its hours", () => {
    expect(milestoneWaiting(verified, changed, options)).toEqual({ waiting: "cooling_off", waitsUntil: new Date("2026-10-22T08:00:00Z") });
  });

  it("asks for the confirmation first while the address is also unconfirmed", () => {
    expect(milestoneWaiting(verified, { ...changed, address_confirmed_at: null }, options)).toEqual({ waiting: "unconfirmed", waitsUntil: null });
  });

  it("asks for an address first in a live workspace with none", () => {
    expect(milestoneWaiting(verified, { address: null, address_changed_at: null, address_confirmed_at: null }, options)).toEqual({ waiting: "no_address", waitsUntil: null });
  });

  it("never waits once its release was sent, whatever the address now is", () => {
    expect(milestoneWaiting({ status: "verified", tx_ref: "0xabc" }, changed, options).waiting).toBeNull();
    expect(milestoneWaiting({ status: "verified", tx_ref: "0xabc" }, { ...changed, address_confirmed_at: null }, options).waiting).toBeNull();
  });

  it("does not wait unless verified: a held milestone waits on a person's decision instead", () => {
    for (const status of ["pending", "held", "paid", "closed"]) expect(milestoneWaiting({ status, tx_ref: null }, changed, options).waiting).toBeNull();
  });

  it("does not wait once the wait has passed, with the lock off or no wait set, or for an address never changed", () => {
    expect(milestoneWaiting(verified, changed, { ...options, now: Date.parse("2026-10-22T08:00:01Z") }).waiting).toBeNull();
    expect(milestoneWaiting(verified, changed, { ...options, lock: { on: false, coolingHours: 24 } }).waiting).toBeNull();
    expect(milestoneWaiting(verified, changed, { ...options, lock: { on: true, coolingHours: 0 } }).waiting).toBeNull();
    expect(milestoneWaiting(verified, { ...changed, address_changed_at: null }, options).waiting).toBeNull();
  });

  it("does not wait for a contractor it cannot find", () => {
    expect(milestoneWaiting(verified, undefined, options).waiting).toBeNull();
  });
});
