import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { REQUEST_TOKEN_TTL_SECONDS, TENANT_ROLE, mintRequestToken } from "@/lib/dal/request-token";

const SECRET = "test-request-token-secret-at-least-32-characters";
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

function parts(token: string) {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    signed: `${header}.${payload}`,
    signature,
  };
}

describe("mintRequestToken", () => {
  it("is an HS256 JWT signed with the project secret", () => {
    const token = parts(mintRequestToken({ orgId: ORG, secret: SECRET, now: NOW }));
    expect(token.header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(token.signature).toBe(crypto.createHmac("sha256", SECRET).update(token.signed).digest("base64url"));
  });

  it("names the tenant role and the organization, and expires in five minutes", () => {
    const { payload } = parts(mintRequestToken({ orgId: ORG, userId: "user-1", secret: SECRET, now: NOW }));
    expect(payload).toEqual({
      role: TENANT_ROLE,
      aud: "authenticated",
      iss: "vestiarion",
      sub: "user-1",
      org_id: ORG,
      iat: NOW / 1000,
      exp: NOW / 1000 + REQUEST_TOKEN_TTL_SECONDS,
    });
    expect(REQUEST_TOKEN_TTL_SECONDS).toBe(300);
  });

  it("names the system as subject when no person is behind the request", () => {
    expect(parts(mintRequestToken({ orgId: ORG, secret: SECRET, now: NOW })).payload.sub).toBe("system");
  });

  it("does not verify under another secret", () => {
    const token = parts(mintRequestToken({ orgId: ORG, secret: SECRET, now: NOW }));
    expect(token.signature).not.toBe(crypto.createHmac("sha256", "another-secret").update(token.signed).digest("base64url"));
  });

  it("refuses to mint without a secret, naming the setting", () => {
    expect(() => mintRequestToken({ orgId: ORG, secret: "", now: NOW })).toThrow(/SUPABASE_JWT_SECRET/);
  });

  it("refuses to mint without an organization", () => {
    expect(() => mintRequestToken({ orgId: "", secret: SECRET, now: NOW })).toThrow(/organization/);
  });
});
