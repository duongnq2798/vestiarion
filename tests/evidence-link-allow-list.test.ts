import { describe, expect, it } from "vitest";
import { checkTargetOf, requestAllowed, signedTokenExpiry, storageHostOf } from "@/lib/evidence-links/allow-list";

/**
 * Which evidence links Vestiarion may check (docs/superpowers/specs/2026-10-13-role-onboarding-evidence-access-design.md
 * E2): a pull request or a comment on github.com, asked about through GitHub's API at an address built here, and a
 * signed link to the workspace's own storage. Everything else is never requested: other schemes, credentials, ports,
 * private or numeric addresses, other hosts, and look-alikes of the allowed ones.
 */

const STORAGE = "abcdefghijklmnop.supabase.co";
const token = (exp: number) => `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(JSON.stringify({ url: "evidence/a.pdf", exp })).toString("base64url")}.sig`;

describe("checkTargetOf: what is on the allow-list", () => {
  it("asks GitHub's API about a pull request, at an address built from the checked parts", () => {
    expect(checkTargetOf("https://github.com/acme/app/pull/12")).toEqual({
      target: { kind: "github_pull", href: "https://github.com/acme/app/pull/12", owner: "acme", repo: "app", number: 12, request: "https://api.github.com/repos/acme/app/pulls/12" },
    });
    for (const tail of ["/", "/files", "/commits", "/checks", "?diff=split"]) {
      const decided = checkTargetOf(`https://github.com/acme/app/pull/12${tail}`);
      expect("target" in decided && decided.target.request).toBe("https://api.github.com/repos/acme/app/pulls/12");
    }
  });

  it("builds the API address from the parser's own path, so a dotted path cannot climb out of the repository", () => {
    expect(checkTargetOf("https://github.com/acme/../../repos/x/pull/1")).toMatchObject({ target: { request: "https://api.github.com/repos/repos/x/pulls/1" } });
  });

  it("asks about a comment on a pull request or an issue by its id, and the repository for whether it is private", () => {
    const decided = checkTargetOf("https://github.com/acme/app/pull/12#issuecomment-987654");
    expect(decided).toMatchObject({
      target: { kind: "github_comment", commentId: 987654, request: "https://api.github.com/repos/acme/app/issues/comments/987654", repository: "https://api.github.com/repos/acme/app" },
    });
    expect(checkTargetOf("https://github.com/acme/app/issues/3#issuecomment-5")).toMatchObject({ target: { kind: "github_comment", commentId: 5 } });
  });

  it("reads a signed link to the workspace's own storage, with its expiry from its token", () => {
    const href = `https://${STORAGE}/storage/v1/object/sign/evidence/a.pdf?token=${token(1_760_000_000)}`;
    expect(checkTargetOf(href, { storageHost: STORAGE })).toEqual({ target: { kind: "signed_storage", href, host: STORAGE, expiresAt: 1_760_000_000_000, request: href } });
  });
});

describe("checkTargetOf: never requested (SSRF)", () => {
  it.each([
    ["http://github.com/acme/app/pull/1", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["ftp://github.com/acme/app/pull/1", "scheme"],
    ["gopher://127.0.0.1:6379/_INFO", "scheme"],
    ["data:text/html,<script>alert(1)</script>", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["https://user:pass@github.com/acme/app/pull/1", "credentials"],
    ["https://github.com:8443/acme/app/pull/1", "port"],
    ["https://127.0.0.1/acme/app/pull/1", "address"],
    ["https://10.0.0.5/", "address"],
    ["https://172.16.0.1/", "address"],
    ["https://192.168.1.1/", "address"],
    ["https://169.254.169.254/latest/meta-data/", "address"],
    ["https://2130706433/", "address"],
    ["https://0x7f.1/", "address"],
    ["https://017700000001/", "address"],
    ["https://[::1]/", "address"],
    ["https://[fd00::1]/", "address"],
    ["https://[::ffff:127.0.0.1]/", "address"],
    ["https://8.8.8.8/", "address"],
    ["https://localhost/acme/app/pull/1", "address"],
    ["https://metadata.google.internal/computeMetadata/v1/", "address"],
    ["https://printer.local/", "address"],
    ["https://intranet/", "address"],
    ["https://drive.example.test/handoff", "host"],
    ["https://evil.example.com/github.com/acme/app/pull/1", "host"],
    ["https://github.com.evil.example.com/acme/app/pull/1", "host"],
    ["https://api.github.com/repos/acme/app/pulls/1", "host"],
    ["https://raw.githubusercontent.com/acme/app/main/README.md", "host"],
    ["https://github.com./acme/app/pull/1", "host"],
    ["https://xn--gthub-cta.com/acme/app/pull/1", "host"],
    ["https://github.com/acme/app", "path"],
    ["https://github.com/acme/app/issues/3", "path"],
    ["https://github.com/acme/app/commit/abc123", "path"],
    ["https://github.com/acme/%2e%2e/pull/1", "path"],
    ["https://github.com/acme/app%2Fpulls/pull/1", "path"],
    ["https://github.com/-acme/app/pull/1", "path"],
    ["https://github.com/acme/app/pull/0", "path"],
    ["https://github.com/acme/app/pull/1#issuecomment-abc", "target"],
    ["not a url", "invalid"],
    ["", "invalid"],
  ])("%s → %s", (raw, reason) => {
    const decided = checkTargetOf(raw, { storageHost: STORAGE });
    if (reason === "target") expect("target" in decided && decided.target.kind).toBe("github_pull");
    else expect(decided).toEqual({ notChecked: reason });
  });

  it("checks no storage but the workspace's own, and only its signed links", () => {
    const signed = `/storage/v1/object/sign/evidence/a.pdf?token=${token(1)}`;
    expect(checkTargetOf(`https://other-project.supabase.co${signed}`, { storageHost: STORAGE })).toEqual({ notChecked: "host" });
    expect(checkTargetOf(`https://${STORAGE}${signed}`, { storageHost: null })).toEqual({ notChecked: "host" });
    expect(checkTargetOf(`https://${STORAGE}/storage/v1/object/public/evidence/a.pdf`, { storageHost: STORAGE })).toEqual({ notChecked: "path" });
    expect(checkTargetOf(`https://${STORAGE}/rest/v1/invoices?select=*`, { storageHost: STORAGE })).toEqual({ notChecked: "path" });
    expect(checkTargetOf(`https://${STORAGE}/storage/v1/object/sign/evidence/a.pdf`, { storageHost: STORAGE })).toEqual({ notChecked: "path" });
  });
});

describe("checkTargetOf: every other way to name a host (SSRF)", () => {
  it.each([
    // IPv6, IPv4 inside IPv6, unique-local, link-local, unspecified, documentation, and a public one.
    ["https://[::ffff:127.0.0.1]/acme/app/pull/1", "address"],
    ["https://[::ffff:7f00:1]/acme/app/pull/1", "address"],
    ["https://[0:0:0:0:0:ffff:a9fe:a9fe]/latest/meta-data/", "address"],
    ["https://[::1]/acme/app/pull/1", "address"],
    ["https://[fc00::1]/", "address"],
    ["https://[fe80::1]/", "address"],
    ["https://[::]/", "address"],
    ["https://[2001:db8::1]/", "address"],
    ["https://[2606:4700::1111]/acme/app/pull/1", "address"],
    ["https://[fe80::1%25eth0]/", "invalid"],
    // IPv4 in decimal, octal, hex and short forms: the parser turns each into a dotted address.
    ["https://2130706433/acme/app/pull/1", "address"],
    ["https://0177.0.0.1/acme/app/pull/1", "address"],
    ["https://0x7f000001/acme/app/pull/1", "address"],
    ["https://0x7f.0x0.0x0.0x1/", "address"],
    ["https://127.1/", "address"],
    ["https://0/", "address"],
    ["https://169.254.169.254./latest/meta-data/", "address"],
    // Trailing dots, look-alikes and suffix tricks.
    ["https://github.com./acme/app/pull/1", "host"],
    ["https://api.github.com./repos/acme/app/pulls/1", "host"],
    ["https://localhost./", "host"],
    ["https://gіthub.com/acme/app/pull/1", "host"],
    ["https://github.co/acme/app/pull/1", "host"],
    ["https://github.com。evil.example/acme/app/pull/1", "host"],
    ["https://github.com%2eevil.example/acme/app/pull/1", "host"],
    ["https://api.github.com.evil.example/repos/acme/app/pulls/1", "host"],
    ["https://evil.example#@github.com/acme/app/pull/1", "host"],
    // A user name or password in any form.
    ["https://api.github.com@evil.example/repos/acme/app/pulls/1", "credentials"],
    ["https://github.com@evil.example/acme/app/pull/1", "credentials"],
    ["https://github.com:@evil.example/acme/app/pull/1", "credentials"],
    ["https://github.com%40evil.example@evil.example/acme/app/pull/1", "credentials"],
    // A backslash is a path separator: the host stays github.com, and the path is not a pull request's.
    ["https://github.com\\@evil.example/acme/app/pull/1", "path"],
  ])("%s → %s, never requested", (raw, reason) => {
    expect(checkTargetOf(raw, { storageHost: STORAGE })).toEqual({ notChecked: reason });
  });

  it("asks GitHub's API only, whatever spelling of github.com the parser normalises", () => {
    for (const raw of ["https://ＧＩＴＨＵＢ.com/acme/app/pull/1", "https://%67ithub.com/acme/app/pull/1", "https://github.com:443/acme/app/pull/1", "HTTPS://GitHub.com/acme/app/pull/1"]) {
      const decided = checkTargetOf(raw);
      expect("target" in decided && decided.target.request, raw).toBe("https://api.github.com/repos/acme/app/pulls/1");
    }
  });

  it("never climbs out of a signed storage path to the rest of the workspace's Supabase", () => {
    for (const path of [
      "/storage/v1/object/sign/../../../rest/v1/orgs",
      "/storage/v1/object/sign/evidence/%2e%2e/%2e%2e/%2e%2e/%2e%2e/rest/v1/orgs",
      "/storage/v1/object/sign/%2E%2E/%2E%2E/auth/v1/admin/users",
    ]) {
      expect(checkTargetOf(`https://${STORAGE}${path}?token=${token(1)}`, { storageHost: STORAGE }), path).toEqual({ notChecked: "path" });
    }
  });
});

describe("storageHostOf", () => {
  it("takes the workspace's Supabase host only when it is an https public name", () => {
    expect(storageHostOf(`https://${STORAGE}`)).toBe(STORAGE);
    expect(storageHostOf("http://127.0.0.1:54321")).toBeNull();
    expect(storageHostOf("https://127.0.0.1")).toBeNull();
    expect(storageHostOf("https://localhost")).toBeNull();
    expect(storageHostOf("https://db.internal")).toBeNull();
    expect(storageHostOf("https://supabase.example.com:8443")).toBeNull();
    expect(storageHostOf("")).toBeNull();
    expect(storageHostOf("nonsense")).toBeNull();
  });
});

describe("requestAllowed: the last check before any request, a redirect's included", () => {
  it("allows GitHub's API under a repository, and the workspace's own signed storage", () => {
    expect(requestAllowed("https://api.github.com/repos/acme/app/pulls/1")).toBe(true);
    expect(requestAllowed("https://api.github.com/repositories/123/pulls/1")).toBe(true);
    expect(requestAllowed(`https://${STORAGE}/storage/v1/object/sign/evidence/a.pdf?token=x`, { storageHost: STORAGE })).toBe(true);
  });

  it("refuses everything else: other GitHub API paths, other hosts, other schemes, private addresses, credentials", () => {
    for (const url of [
      "https://api.github.com/user",
      "https://api.github.com/app/installations",
      "https://github.com/acme/app/pull/1",
      "http://api.github.com/repos/acme/app/pulls/1",
      "https://user:pass@api.github.com/repos/acme/app/pulls/1",
      "https://api.github.com:444/repos/acme/app/pulls/1",
      "https://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1/repos/acme/app/pulls/1",
      "https://evil.example.com/repos/acme/app/pulls/1",
      `https://${STORAGE}/rest/v1/invoices`,
      `https://${STORAGE}/storage/v1/object/public/evidence/a.pdf`,
      `https://other-project.supabase.co/storage/v1/object/sign/evidence/a.pdf?token=x`,
    ]) {
      expect(requestAllowed(url, { storageHost: STORAGE }), url).toBe(false);
    }
  });
});

describe("signedTokenExpiry", () => {
  it("reads the token's own expiry, and nothing from a token that does not say", () => {
    expect(signedTokenExpiry(token(1_760_000_000))).toBe(1_760_000_000_000);
    expect(signedTokenExpiry("not-a-token")).toBeNull();
    expect(signedTokenExpiry("a.%%%.c")).toBeNull();
  });
});
