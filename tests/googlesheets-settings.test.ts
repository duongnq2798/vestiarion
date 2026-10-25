import { afterEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_SHEETS_SCOPES, googleSheetsSettingsFromEnv } from "@/lib/googlesheets/settings";

/**
 * The deployment's one Google OAuth client for Google Sheets (docs/superpowers/specs/2026-10-25-close-pack-google-sheets-design.md
 * GS2, GS3): off unless both variables are set and the id is a Google OAuth client id, which is logged without its value;
 * and exactly one scope, Drive's per-file access.
 */

const ID = "1234567890-abc123def456.apps.googleusercontent.com";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("googleSheetsSettingsFromEnv (close pack Sheets GS2)", () => {
  it("is off unless both variables are set", () => {
    expect(googleSheetsSettingsFromEnv({})).toBeNull();
    expect(googleSheetsSettingsFromEnv({ GOOGLE_SHEETS_CLIENT_ID: ID })).toBeNull();
    expect(googleSheetsSettingsFromEnv({ GOOGLE_SHEETS_CLIENT_SECRET: "GOCSPX-secret" })).toBeNull();
    expect(googleSheetsSettingsFromEnv({ GOOGLE_SHEETS_CLIENT_ID: "  ", GOOGLE_SHEETS_CLIENT_SECRET: "GOCSPX-secret" })).toBeNull();
  });

  it("takes a Google OAuth client id, and trims both", () => {
    expect(googleSheetsSettingsFromEnv({ GOOGLE_SHEETS_CLIENT_ID: ` ${ID} `, GOOGLE_SHEETS_CLIENT_SECRET: " GOCSPX-secret\n" })).toEqual({
      clientId: ID,
      clientSecret: "GOCSPX-secret",
    });
  });

  it("is off with an id that is not a Google OAuth client id, logging that and never the value", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const id of ["not-an-id", "1234567890-ABC.apps.googleusercontent.com", "abc-123.apps.googleusercontent.com", `${ID}.evil.test`, "1234567890-abc123.apps.googleusercontent.com/x"]) {
      expect(googleSheetsSettingsFromEnv({ GOOGLE_SHEETS_CLIENT_ID: id, GOOGLE_SHEETS_CLIENT_SECRET: "GOCSPX-secret" }), id).toBeNull();
    }
    expect(warned).toHaveBeenCalledWith("Google Sheets is off: GOOGLE_SHEETS_CLIENT_ID is not a Google OAuth client id");
    const logged = JSON.stringify(warned.mock.calls);
    expect(logged).not.toContain("not-an-id");
    expect(logged).not.toContain("GOCSPX");
    expect(logged).not.toContain("evil");
  });

  it("reads process.env by default", () => {
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_ID", ID);
    vi.stubEnv("GOOGLE_SHEETS_CLIENT_SECRET", "GOCSPX-secret");
    try {
      expect(googleSheetsSettingsFromEnv()).toEqual({ clientId: ID, clientSecret: "GOCSPX-secret" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(googleSheetsSettingsFromEnv()).toBeNull();
  });
});

describe("GOOGLE_SHEETS_SCOPES (close pack Sheets GS3)", () => {
  it("is exactly Drive's per-file access: no spreadsheets, drive, openid, email or profile scope", () => {
    expect(GOOGLE_SHEETS_SCOPES).toEqual(["https://www.googleapis.com/auth/drive.file"]);
  });
});
