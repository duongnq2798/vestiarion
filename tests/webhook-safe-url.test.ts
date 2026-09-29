import { describe, expect, it } from "vitest";
import { isPublicAddress, validateWebhookUrl } from "@/lib/webhooks/safe-url";

/**
 * Safe webhook destinations (webhooks design W6): the URL is https, on port
 * 443 or none, with no credentials, and a literal IP host must be public,
 * IPv6 and IPv4-mapped forms included. The resolved addresses of a host name
 * are checked by the sender's own lookup (tests/webhook-http.test.ts).
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

  // The URL parser normalises a host before it is checked, so every other
  // spelling of a refused address is refused too.
  it.each([
    ["an octal IPv4 host", "https://0177.0.0.1/", "127.0.0.1"],
    ["a decimal IPv4 host", "https://2130706433/", "127.0.0.1"],
    ["a hex IPv4 host", "https://0x7f000001/", "127.0.0.1"],
    ["a short IPv4 host", "https://127.1/", "127.0.0.1"],
    ["a trailing dot", "https://127.0.0.1./", "127.0.0.1"],
    ["the host 0", "https://0/", "0.0.0.0"],
    ["an uppercase bracketed IPv6 host", "https://[::FFFF:7F00:1]/", "[::ffff:7f00:1]"],
    ["an uppercase link-local IPv6 host", "https://[FE80::1]/", "[fe80::1]"],
    ["the metadata address, IPv4-mapped in hex", "https://[::ffff:a9fe:a9fe]/", "[::ffff:a9fe:a9fe]"],
  ])("refuses %s, which the URL parser normalises to a refused address", (_label, raw, normalised) => {
    expect(new URL(raw).hostname).toBe(normalised);
    const check = validateWebhookUrl(raw);
    expect(check).toEqual({ ok: false, reason: "the URL's address is not public" });
  });

  it.each([
    ["an encoded zone id", "https://[fe80::1%25eth0]/"],
    ["a raw zone id", "https://[fe80::1%eth0]/"],
    ["a zone id on a public address", "https://[2606:4700::1111%25eth0]/"],
  ])("refuses %s, which is not a valid URL", (_label, raw) => {
    expect(validateWebhookUrl(raw)).toEqual({ ok: false, reason: "not a valid URL" });
  });

  it.each([
    ["192.0.2.1"], ["198.51.100.7"], ["203.0.113.254"],
  ])("refuses the documentation address %s as a literal host", (ip) => {
    expect(validateWebhookUrl(`https://${ip}/in`)).toEqual({ ok: false, reason: "the URL's address is not public" });
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
    ["192.0.1.255"], ["192.0.3.0"], ["198.51.99.255"], ["198.51.101.0"], ["203.0.112.255"], ["203.0.114.0"],
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
    // Documentation: 192.0.2/24, 198.51.100/24, 203.0.113/24
    ["192.0.2.0"], ["192.0.2.1"], ["192.0.2.255"],
    ["198.51.100.0"], ["198.51.100.7"], ["198.51.100.255"],
    ["203.0.113.0"], ["203.0.113.9"], ["203.0.113.255"],
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
