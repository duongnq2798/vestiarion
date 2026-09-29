import { describe, expect, it } from "vitest";
import { redactPath } from "@/lib/analytics/redact";

describe("redactPath", () => {
  it.each([
    ["/invite/abc", "/invite/:token"],
    ["/invite/abc/", "/invite/:token"],
    ["/invite/abc/extra", "/invite/:token"],
    ["/o/acme", "/o/:org"],
    ["/o/acme/", "/o/:org/"],
    ["/o/acme/audit", "/o/:org/audit"],
    ["/", "/"],
    ["/docs/api", "/docs/api"],
  ])("redacts %s as %s", (pathname, expected) => {
    expect(redactPath(pathname)).toBe(expected);
  });
});
