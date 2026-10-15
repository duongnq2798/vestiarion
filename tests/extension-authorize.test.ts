import { describe, expect, it } from "vitest";
import { checkAuthorizeRequest, redirectWith } from "@/lib/extension/authorize-request";
import { challengeOf, isVerifier, verifierMatches } from "@/lib/extension/pkce";
import { allowedClient, allowedOrigin, DOWNLOAD_EXTENSION_ID, extensionSettingsFromEnv, parseExtensionIds, parseScopes, redirectUriFor } from "@/lib/extension/settings";
import { newToken, tokenKind } from "@/lib/extension/tokens";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import nextConfig from "../next.config";

/**
 * The Chrome extension's authorization, as pure rules (docs/superpowers/specs/2026-10-15-invoice-capture-design.md
 * C12, C15, C16, C21): which extensions may connect and from where, PKCE S256 as RFC 7636 writes it, the authorize
 * request's refusals (never an open redirect), the tokens' forms, and the one surface the extension acts on.
 */

const CLIENT = "abcdefghijklmnopabcdefghijklmnop";
const settings = { ids: [CLIENT] };

describe("CHROME_EXTENSION_IDS (C12)", () => {
  it("keeps extension ids only, once each, separated by commas or spaces", () => {
    expect(parseExtensionIds(` ${CLIENT},${CLIENT} ponmlkjihgfedcbaponmlkjihgfedcba, not-an-id, ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP`)).toEqual([
      CLIENT,
      "ponmlkjihgfedcbaponmlkjihgfedcba",
    ]);
    expect(extensionSettingsFromEnv(undefined)).toBeNull();
    expect(extensionSettingsFromEnv("nothing useful")).toBeNull();
    // Once any id is listed, the copy offered for download is allowed too, by the one id its manifest's key gives it.
    expect(extensionSettingsFromEnv(CLIENT)).toEqual({ ids: [CLIENT, DOWNLOAD_EXTENSION_ID] });
    expect(extensionSettingsFromEnv(`${CLIENT} ${DOWNLOAD_EXTENSION_ID}`)).toEqual({ ids: [CLIENT, DOWNLOAD_EXTENSION_ID] });
  });

  it("allows an extension's own redirect address, exactly, and its own origin", () => {
    expect(redirectUriFor(CLIENT)).toBe(`https://${CLIENT}.chromiumapp.org/`);
    expect(allowedClient(settings, CLIENT, `https://${CLIENT}.chromiumapp.org/`)).toBe(true);
    for (const redirect of [`https://${CLIENT}.chromiumapp.org/x`, `http://${CLIENT}.chromiumapp.org/`, "https://evil.example/", `https://${CLIENT}.chromiumapp.org.evil.example/`]) {
      expect(allowedClient(settings, CLIENT, redirect), redirect).toBe(false);
    }
    expect(allowedClient(settings, "ponmlkjihgfedcbaponmlkjihgfedcba", "https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/")).toBe(false);
    expect(allowedOrigin(settings, `chrome-extension://${CLIENT}`)).toBe(true);
    expect(allowedOrigin(settings, `chrome-extension://${CLIENT}/`)).toBe(false);
    expect(allowedOrigin(settings, "https://www.vestiarion.xyz")).toBe(false);
    expect(allowedOrigin(settings, null)).toBe(false);
  });

  it("grants the draft scopes and nothing else", () => {
    expect(parseScopes(undefined)).toEqual(["invoice_draft:create", "invoice_draft:read"]);
    expect(parseScopes("invoice_draft:read")).toEqual(["invoice_draft:read"]);
    expect(parseScopes("invoice_draft:read invoices:write")).toBeNull();
    expect(parseScopes("payments")).toBeNull();
  });
});

describe("PKCE S256 (C14)", () => {
  it("matches RFC 7636's own example", () => {
    // RFC 7636 Appendix B.
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(verifierMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });

  it("refuses a wrong, short or plain verifier", () => {
    const challenge = challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(verifierMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXK", challenge)).toBe(false);
    expect(verifierMatches("short", challengeOf("short"))).toBe(false);
    expect(verifierMatches(challenge, challenge)).toBe(false);
    expect(verifierMatches(undefined, challenge)).toBe(false);
    expect(isVerifier("a".repeat(129))).toBe(false);
  });

  it("is computed the same way by the extension", async () => {
    const { challengeOf: extensionChallenge, newVerifier } = await import("../extensions/chrome-invoice-capture/extension/lib/pkce.js");
    const verifier = newVerifier();
    expect(isVerifier(verifier)).toBe(true);
    expect(await extensionChallenge(verifier)).toBe(challengeOf(verifier));
  });
});

describe("the authorize request (C12)", () => {
  const good = {
    response_type: "code",
    client_id: CLIENT,
    redirect_uri: `https://${CLIENT}.chromiumapp.org/`,
    code_challenge: challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    code_challenge_method: "S256",
    state: "s-123",
  };

  it("accepts an allowed extension's request, with every scope when none is named", () => {
    expect(checkAuthorizeRequest(settings, good)).toEqual({
      kind: "ok",
      request: { clientId: CLIENT, redirectUri: good.redirect_uri, codeChallenge: good.code_challenge, state: "s-123", scopes: ["invoice_draft:create", "invoice_draft:read"] },
    });
  });

  it("never redirects for an unknown client or a redirect address that is not the client's own", () => {
    expect(checkAuthorizeRequest(settings, { ...good, client_id: "ponmlkjihgfedcbaponmlkjihgfedcba" })).toEqual({ kind: "bad_client" });
    expect(checkAuthorizeRequest(settings, { ...good, redirect_uri: "https://evil.example/" })).toEqual({ kind: "bad_client" });
    expect(checkAuthorizeRequest(settings, { ...good, client_id: undefined })).toEqual({ kind: "bad_client" });
  });

  it("sends anything else back to the extension with its state", () => {
    const back = (params: Record<string, string | undefined>) => {
      const check = checkAuthorizeRequest(settings, { ...good, ...params });
      if (check.kind !== "redirect_error") throw new Error(`expected a redirect, got ${check.kind}`);
      return new URL(check.redirectTo);
    };
    expect(back({ response_type: "token" }).searchParams.get("error")).toBe("unsupported_response_type");
    expect(back({ code_challenge_method: "plain" }).searchParams.get("error")).toBe("invalid_request");
    expect(back({ code_challenge: "short" }).searchParams.get("error")).toBe("invalid_request");
    expect(back({ scope: "invoice_draft:read payments:write" }).searchParams.get("error")).toBe("invalid_scope");
    expect(back({ scope: "invoice_draft:read payments:write" }).searchParams.get("state")).toBe("s-123");
    const noState = back({ state: undefined });
    expect(noState.searchParams.get("error")).toBe("invalid_request");
    expect(noState.origin).toBe(`https://${CLIENT}.chromiumapp.org`);
  });

  it("is never shown inside another site's frame, and its address is never sent on as a referrer", async () => {
    expect(await nextConfig.headers!()).toContainEqual({
      source: "/extension/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Referrer-Policy", value: "same-origin" },
      ],
    });
  });

  it("adds the code and state to the redirect address", () => {
    expect(redirectWith(`https://${CLIENT}.chromiumapp.org/`, { code: "vxc_a b", state: "s&1" })).toBe(`https://${CLIENT}.chromiumapp.org/?code=vxc_a+b&state=s%261`);
  });
});

describe("the tokens and the surface (C15, C16)", () => {
  it("tells codes, access and refresh tokens apart by their form, and an API key is none of them", () => {
    expect(tokenKind(newToken("vxc").token)).toBe("code");
    expect(tokenKind(newToken("vxa").token)).toBe("access");
    expect(tokenKind(newToken("vxr").token)).toBe("refresh");
    expect(tokenKind(`vxk_abcdefgh_${"a".repeat(43)}`)).toBeNull();
    expect(tokenKind("vxa_short")).toBeNull();
  });

  it("lets the extension capture, edit and send a draft, and run nothing else", () => {
    expect([...SURFACE_COMMANDS.chrome].sort()).toEqual(["invoice_draft.capture", "invoice_draft.edit", "invoice_draft.send"]);
    for (const surface of ["telegram", "slack", "api", "github"] as const) {
      for (const command of ["invoice_draft.capture", "invoice_draft.edit", "invoice_draft.send", "invoice_draft.confirm", "invoice_draft.discard"] as const) {
        expect(SURFACE_COMMANDS[surface]).not.toContain(command);
      }
    }
    // Adding the bill and discarding the draft are the console's alone.
    expect(Object.entries(SURFACE_COMMANDS).filter(([, commands]) => commands.includes("invoice_draft.confirm")).map(([surface]) => surface)).toEqual(["console"]);
    for (const command of ["invoice_draft.capture", "invoice_draft.edit", "invoice_draft.send", "invoice_draft.confirm", "invoice_draft.discard"] as const) {
      expect(COMMAND_PERMISSIONS[command]).toBe("records.write");
    }
  });
});
