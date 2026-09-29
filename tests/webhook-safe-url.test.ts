import { describe, expect, it, vi } from "vitest";
import { assertPublicDestination, isPublicAddress, validateWebhookUrl } from "@/lib/webhooks/safe-url";

/**
 * Safe webhook destinations (webhooks design W6): the URL is https, on port
 * 443 or none, with no credentials; at send time every address the host
 * resolves to must be public, IPv6 and IPv4-mapped forms included.
 */

describe("validateWebhookUrl", () => {
  it.each([
    "https://hooks.example.com/in",
    "https://hooks.example.com:443/in?x=1",
    "https://HOOKS.example.com",
    "  https://hooks.example.com/in  ",
    "https://1.1.1.1/in",
    "https://[2606:4700::1111]/in",
  ])("accepts %s", (raw) => {
    const check = validateWebhookUrl(raw);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.url.protocol).toBe("https:");
      expect(check.url.port).toBe("");
    }
  });

  it.each([
    ["not a URL", "hooks.example.com/in", /valid/],
    ["empty", "", /valid/],
    ["http", "http://hooks.example.com/in", /https/],
    ["another scheme", "ftp://hooks.example.com/in", /https/],
    ["a user name", "https://user@hooks.example.com/in", /credentials/],
    ["a user and password", "https://user:pass@hooks.example.com/in", /credentials/],
    ["a password only", "https://:pass@hooks.example.com/in", /credentials/],
    ["port 8443", "https://hooks.example.com:8443/in", /443/],
    ["port 80", "https://hooks.example.com:80/in", /443/],
    ["port 444", "https://hooks.example.com:444/in", /443/],
    ["a loopback literal", "https://127.0.0.1/in", /public/],
    ["a loopback literal in hex", "https://0x7f.0.0.1/in", /public/],
    ["a loopback literal as one number", "https://2130706433/in", /public/],
    ["an IPv6 loopback literal", "https://[::1]/in", /public/],
    ["an IPv4-mapped loopback literal", "https://[::ffff:127.0.0.1]/in", /public/],
    ["a private literal", "https://10.0.0.5/in", /public/],
    ["over 500 characters", "https://hooks.example.com/" + "a".repeat(475), /500/],
  ])("refuses %s", (_label, raw, reason) => {
    const check = validateWebhookUrl(raw);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(reason);
  });

  it("accepts exactly 500 characters", () => {
    const raw = "https://hooks.example.com/" + "a".repeat(474);
    expect(raw).toHaveLength(500);
    expect(validateWebhookUrl(raw).ok).toBe(true);
  });

  it("refuses a value that is not a string", () => {
    expect(validateWebhookUrl(undefined as unknown as string).ok).toBe(false);
  });
});

describe("isPublicAddress", () => {
  it.each([
    ["1.1.1.1"], ["8.8.8.8"], ["93.184.216.34"],
    // The edges just outside each refused IPv4 range.
    ["1.0.0.0"], ["9.255.255.255"], ["11.0.0.0"],
    ["100.63.255.255"], ["100.128.0.0"],
    ["126.255.255.255"], ["128.0.0.0"],
    ["169.253.255.255"], ["169.255.0.0"],
    ["172.15.255.255"], ["172.32.0.0"],
    ["191.255.255.255"], ["192.0.1.0"],
    ["192.167.255.255"], ["192.169.0.0"],
    ["198.17.255.255"], ["198.20.0.0"],
    ["223.255.255.255"],
    // IPv6 global unicast.
    ["2606:4700::1111"], ["2606:4700:4700::1001"], ["2a00:1450:4001:82a::200e"],
    ["::ffff:1.1.1.1"], ["::ffff:101:101"], ["::FFFF:8.8.8.8"],
    ["[2606:4700::1111]"],
  ])("accepts %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    // 0.0.0.0/8
    ["0.0.0.0"], ["0.255.255.255"],
    // 10/8
    ["10.0.0.0"], ["10.255.255.255"],
    // 100.64/10
    ["100.64.0.0"], ["100.127.255.255"],
    // 127/8
    ["127.0.0.0"], ["127.0.0.1"], ["127.255.255.255"],
    // 169.254/16
    ["169.254.0.0"], ["169.254.169.254"], ["169.254.255.255"],
    // 172.16/12
    ["172.16.0.0"], ["172.31.255.255"],
    // 192.0.0/24
    ["192.0.0.0"], ["192.0.0.255"],
    // 192.168/16
    ["192.168.0.0"], ["192.168.255.255"],
    // 198.18/15
    ["198.18.0.0"], ["198.19.255.255"],
    // 224/4 and above
    ["224.0.0.0"], ["239.255.255.255"], ["240.0.0.0"], ["255.255.255.255"],
  ])("refuses the IPv4 address %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    // ::, ::1 and their long forms
    ["::"], ["::1"], ["0:0:0:0:0:0:0:0"], ["0:0:0:0:0:0:0:1"], ["[::1]"],
    // fc00::/7
    ["fc00::"], ["fc00::1"], ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"], ["fd12:3456::1"],
    // fe80::/10, with and without a zone
    ["fe80::"], ["fe80::1"], ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"], ["fe80::1%eth0"],
    // ff00::/8
    ["ff00::"], ["ff02::1"], ["ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ])("refuses the IPv6 address %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ["::ffff:127.0.0.1"], ["::ffff:7f00:1"], ["::FFFF:7F00:0001"], ["0:0:0:0:0:ffff:127.0.0.1"], ["[::ffff:127.0.0.1]"],
    ["::ffff:0.0.0.0"], ["::ffff:10.1.2.3"], ["::ffff:a01:203"], ["::ffff:100.64.0.1"], ["::ffff:169.254.169.254"],
    ["::ffff:a9fe:a9fe"], ["::ffff:172.16.0.1"], ["::ffff:192.0.0.8"], ["::ffff:192.168.1.1"], ["::ffff:c0a8:101"],
    ["::ffff:198.18.0.1"], ["::ffff:224.0.0.1"], ["::ffff:255.255.255.255"],
  ])("refuses the IPv4-mapped address %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ["the deprecated IPv4-compatible loopback", "::127.0.0.1"],
    ["an IPv4-compatible public address", "::1.1.1.1"],
    ["NAT64 to a private address", "64:ff9b::10.0.0.1"],
    ["6to4 wrapping loopback", "2002:7f00:1::"],
    ["6to4 wrapping a private address", "2002:c0a8:101::1"],
    ["documentation", "2001:db8::1"],
    ["Teredo", "2001:0:4136:e378::1"],
    ["the unassigned space outside 2000::/3", "4000::1"],
  ])("refuses %s (%s)", (_label, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ["NAT64 to a public address", "64:ff9b::1.1.1.1"],
    ["6to4 wrapping a public address", "2002:101:101::1"],
  ])("accepts %s (%s)", (_label, ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    ["a host name", "example.com"],
    ["empty", ""],
    ["a short IPv4 form", "127.1"],
    ["an IPv4 address with a leading zero", "010.0.0.1"],
    ["an octet above 255", "256.1.1.1"],
    ["a malformed IPv6 address", "2606:4700:::1111"],
    ["too many IPv6 groups", "1:2:3:4:5:6:7:8:9"],
    ["not a string", undefined as unknown as string],
  ])("refuses %s, which is not an address", (_label, ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("assertPublicDestination", () => {
  const url = new URL("https://hooks.example.com/in");

  it("accepts a host whose every address is public, and looks up that host", async () => {
    const lookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
    const check = await assertPublicDestination(url, lookup);
    expect(check).toEqual({ ok: true, url });
    expect(lookup).toHaveBeenCalledWith("hooks.example.com");
  });

  it.each([
    ["a private IPv4 address among public ones", [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }]],
    ["an IPv6 loopback among public ones", [{ address: "2606:4700::1111", family: 6 }, { address: "::1", family: 6 }]],
    ["an IPv4-mapped loopback", [{ address: "::ffff:7f00:1", family: 6 }]],
    ["the metadata address", [{ address: "169.254.169.254", family: 4 }]],
  ])("refuses a mixed or private answer: %s", async (_label, answer) => {
    const check = await assertPublicDestination(url, async () => answer);
    expect(check).toEqual({ ok: false, reason: "destination is not public" });
  });

  it("refuses when resolution fails", async () => {
    const check = await assertPublicDestination(url, async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND hooks.example.com"), { code: "ENOTFOUND" });
    });
    expect(check).toEqual({ ok: false, reason: "destination could not be resolved" });
  });

  it("refuses an empty answer", async () => {
    const check = await assertPublicDestination(url, async () => []);
    expect(check).toEqual({ ok: false, reason: "destination could not be resolved" });
  });

  it("checks an IP literal host without a lookup", async () => {
    const lookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    expect((await assertPublicDestination(new URL("https://[2606:4700::1111]/in"), lookup)).ok).toBe(true);
    expect(await assertPublicDestination(new URL("https://[::ffff:127.0.0.1]/in"), lookup)).toMatchObject({ ok: false });
    expect(await assertPublicDestination(new URL("https://169.254.169.254/latest"), lookup)).toMatchObject({ ok: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("re-checks the URL's own rules, never looking up an http or credentialed URL", async () => {
    const lookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    expect(await assertPublicDestination(new URL("http://hooks.example.com/in"), lookup)).toMatchObject({ ok: false });
    expect(await assertPublicDestination(new URL("https://u:p@hooks.example.com/in"), lookup)).toMatchObject({ ok: false });
    expect(await assertPublicDestination(new URL("https://hooks.example.com:8443/in"), lookup)).toMatchObject({ ok: false });
    expect(lookup).not.toHaveBeenCalled();
  });
});
