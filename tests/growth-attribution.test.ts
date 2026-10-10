import { describe, expect, it } from "vitest";
import {
  COOKIE_MAX_BYTES,
  FIRST_TOUCH_MAX_AGE_SECONDS,
  firstTouchCookie,
  firstTouchFrom,
  hasFirstTouch,
  parseFirstTouch,
  sanitizeHost,
  sanitizePath,
  sanitizeTag,
  serializeFirstTouch,
} from "@/lib/growth/attribution";

/**
 * The first-touch cookie (src/lib/growth/attribution.ts): campaign tags only, each cut to a safe alphabet and 100
 * characters, the landing path without its query, the referrer's host, and when; under 1 KB; read back on the server
 * as warily as it was written.
 */

const NOW = new Date("2026-10-10T08:30:00.000Z");
const at = (search: string, pathname = "/", host = "www.vestiarion.xyz") => ({ search, pathname, host });

describe("sanitizing", () => {
  it("keeps [A-Za-z0-9._~-], turns spaces into hyphens and drops the rest, at most 100 characters", () => {
    expect(sanitizeTag("  LinkedIn Oct  post ")).toBe("LinkedIn-Oct-post");
    expect(sanitizeTag("a<script>b")).toBe("ascriptb");
    expect(sanitizeTag("x".repeat(250))).toHaveLength(100);
    expect(sanitizeTag("   ")).toBeNull();
    expect(sanitizeTag("<>")).toBeNull();
    expect(sanitizeTag(null)).toBeNull();
  });

  it("drops a tag with an @ whole, so no email survives", () => {
    expect(sanitizeTag("jane@acme.example")).toBeNull();
    expect(sanitizeTag("jane%40acme")).toBe("jane40acme");
  });

  it("keeps a path without its query and a host in lower case", () => {
    expect(sanitizePath("/docs/start?email=x@y.z#top")).toBe("/docs/start");
    expect(sanitizePath("no-slash")).toBeNull();
    expect(sanitizeHost("WWW.LinkedIn.com")).toBe("www.linkedin.com");
    expect(sanitizeHost("localhost")).toBeNull();
    expect(sanitizeHost("evil.example/path")).toBeNull();
  });
});

describe("firstTouchFrom", () => {
  it("is null without a campaign tag", () => {
    expect(firstTouchFrom(at("?page=2"), "https://google.com/", NOW)).toBeNull();
    expect(firstTouchFrom(at("?utm_source=%40%40"), "", NOW)).toBeNull();
  });

  it("keeps the tags, the landing path, another site's host and the time", () => {
    expect(
      firstTouchFrom(at("?utm_source=linkedin&utm_medium=social&utm_campaign=agency%20oct&utm_content=post-1&utm_term=ap&ref=duong&email=a@b.c", "/open"), "https://www.linkedin.com/feed/?x=1", NOW)
    ).toEqual({
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: "agency-oct",
      utm_content: "post-1",
      utm_term: "ap",
      ref: "duong",
      landing_path: "/open",
      referrer_host: "www.linkedin.com",
      first_seen_at: "2026-10-10T08:30:00.000Z",
    });
  });

  it("leaves out a referrer from this site, or one that is not a web address", () => {
    expect(firstTouchFrom(at("?ref=x"), "https://www.vestiarion.xyz/docs", NOW)?.referrer_host).toBeUndefined();
    expect(firstTouchFrom(at("?ref=x"), "android-app://com.slack", NOW)?.referrer_host).toBeUndefined();
  });
});

describe("the cookie", () => {
  it("round-trips through serialize and parse", () => {
    const touch = firstTouchFrom(at("?utm_source=x&utm_campaign=launch", "/pricing"), "https://news.ycombinator.com/item?id=1", NOW)!;
    expect(parseFirstTouch(serializeFirstTouch(touch))).toEqual(touch);
    // A percent-encoded copy reads the same.
    expect(parseFirstTouch(encodeURIComponent(serializeFirstTouch(touch)))).toEqual(touch);
  });

  it("stays under 1 KB with every field at its longest", () => {
    const long = "a".repeat(300);
    const search = `?${["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "ref"].map((key) => `${key}=${long}`).join("&")}`;
    const touch = firstTouchFrom(at(search, `/${"p".repeat(300)}`), `https://${"h".repeat(60)}.${"i".repeat(39)}/`, NOW)!;
    const cookie = firstTouchCookie(touch, true);
    expect(serializeFirstTouch(touch).length).toBeLessThan(COOKIE_MAX_BYTES);
    expect(cookie.length).toBeLessThan(COOKIE_MAX_BYTES);
  });

  it("is first-party, 90 days, on every path, SameSite=Lax, and Secure on https", () => {
    const touch = { utm_source: "x" };
    expect(firstTouchCookie(touch, true)).toBe(`vx_ft=v=1&s=x; Max-Age=${FIRST_TOUCH_MAX_AGE_SECONDS}; Path=/; SameSite=Lax; Secure`);
    expect(FIRST_TOUCH_MAX_AGE_SECONDS).toBe(90 * 24 * 60 * 60);
    expect(firstTouchCookie(touch, false)).not.toContain("Secure");
    expect(firstTouchCookie(touch, false)).not.toMatch(/Domain=/);
  });

  it("is noticed among other cookies", () => {
    expect(hasFirstTouch("a=1; vx_ft=v=1&s=x; b=2")).toBe(true);
    expect(hasFirstTouch("a=1; not_vx_ft=1")).toBe(false);
    expect(hasFirstTouch("")).toBe(false);
  });

  it("is read back warily: re-sanitized, and null when absent, too long, of another version, or without a tag", () => {
    expect(parseFirstTouch(undefined)).toBeNull();
    expect(parseFirstTouch("")).toBeNull();
    expect(parseFirstTouch(`v=1&s=${"a".repeat(2000)}`)).toBeNull();
    expect(parseFirstTouch("v=2&s=x")).toBeNull();
    expect(parseFirstTouch("v=1&p=/x")).toBeNull();
    expect(parseFirstTouch("v=1&s=a@b.c&c=ok")).toEqual({ utm_campaign: "ok" });
    expect(parseFirstTouch("v=1&s=<b>x</b>&h=Evil Host&at=yesterday&p=//x")).toEqual({ utm_source: "bxb", landing_path: "//x" });
    expect(parseFirstTouch("%E0%A4%A")).toBeNull();
  });
});
