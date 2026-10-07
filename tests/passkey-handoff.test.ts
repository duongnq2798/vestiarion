import { encode } from "uqr";
import { describe, expect, it } from "vitest";
import { handoffView, qrPath } from "@/lib/passkey-handoff";

/**
 * "Use your phone instead" under a passkey button (2026-10-07): a code that opens the same page on the phone, so a
 * passkey is made or used there without the browser's Bluetooth link to the phone. The partner's Windows PC, with no
 * Windows Hello, stayed on "Connecting to your device"; the same page on the iPhone made the treasury's passkey at once.
 */

describe("handoffView", () => {
  it("opens the handoff where the device keeps no passkey of its own", () => {
    expect(handoffView({ finePointer: true, deviceKeepsPasskeys: false })).toBe("open");
    expect(handoffView({ finePointer: null, deviceKeepsPasskeys: false })).toBe("open");
  });

  it("offers it folded on a computer that keeps passkeys, or before it is known whether it does", () => {
    expect(handoffView({ finePointer: true, deviceKeepsPasskeys: true })).toBe("collapsed");
    expect(handoffView({ finePointer: true, deviceKeepsPasskeys: null })).toBe("collapsed");
  });

  it("leaves it out on a phone that keeps its own passkeys, and while nothing is known", () => {
    expect(handoffView({ finePointer: false, deviceKeepsPasskeys: true })).toBe("hidden");
    expect(handoffView({ finePointer: null, deviceKeepsPasskeys: null })).toBe("hidden");
  });
});

describe("qrPath", () => {
  it("draws one square for each dark module of the page's QR code, inside a quiet zone of two modules", () => {
    const url = "https://www.vestiarion.xyz/o/mainnet-wp/settings";
    const { size, path } = qrPath(url);
    const modules = encode(url, { border: 2 }).data;
    expect(size).toBe(modules.length);
    expect(path.match(/M/g)).toHaveLength(modules.flat().filter(Boolean).length);
    expect(path).not.toMatch(/M[01] /);
    expect(path).not.toMatch(/M\d+ [01]h/);
  });
});
