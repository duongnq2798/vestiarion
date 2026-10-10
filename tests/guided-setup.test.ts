import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkGuidedSetupToken,
  firstTouchLine,
  guidedSetupSchema,
  guidedSetupToken,
  inboundLead,
  INBOUND_SIGNAL,
  MIN_FILL_MS,
  TOKEN_TTL_MS,
} from "@/lib/growth/guided-setup";
import { LEAD_CSV_HEADERS } from "@/lib/growth/csv";
import { CONTACT_CHANNELS, SEGMENTS, SOURCES } from "@/lib/growth/fields";

/**
 * The guided setup request's pure parts (src/lib/growth/guided-setup.ts): the signed form token that proves a page drew
 * the form long enough ago, the fields' checks, and the lead row growth_import_leads receives.
 */

const key = (id: string) => ({ id, key: crypto.randomBytes(32) });
const KEY = key("k1");
const OTHER = key("k2");
const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);

const VALID = {
  name: " Lan Pham ",
  email: " lan@northwind.example ",
  studio: "Northwind Studio",
  website: "https://www.northwind.example/work",
  contractors: "4-10",
  arrival: "chat",
  message: "We pay six illustrators a month.",
};

describe("the form token", () => {
  it("is good once the page has been open a few seconds, and until a day has passed", () => {
    const token = guidedSetupToken([KEY], T0);
    expect(token).toMatch(/^vx1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    expect(checkGuidedSetupToken(token, [KEY], T0 + MIN_FILL_MS)).toBe("ok");
    expect(checkGuidedSetupToken(token, [KEY], T0 + TOKEN_TTL_MS)).toBe("ok");
  });

  it("is too fast when sent sooner than a person could fill the form", () => {
    expect(checkGuidedSetupToken(guidedSetupToken([KEY], T0), [KEY], T0 + MIN_FILL_MS - 1)).toBe("too_fast");
  });

  it("has expired after a day", () => {
    expect(checkGuidedSetupToken(guidedSetupToken([KEY], T0), [KEY], T0 + TOKEN_TTL_MS + 1)).toBe("expired");
  });

  it("is invalid when missing, malformed, signed with another key, altered, or dated in the future", () => {
    const token = guidedSetupToken([KEY], T0);
    expect(checkGuidedSetupToken("", [KEY], T0 + 10_000)).toBe("invalid");
    expect(checkGuidedSetupToken("not-a-token", [KEY], T0 + 10_000)).toBe("invalid");
    expect(checkGuidedSetupToken(token, [OTHER], T0 + 10_000)).toBe("invalid");
    const [, , signature] = token.split(".");
    const forged = `vx1.${Buffer.from(JSON.stringify({ t: T0 - 60_000 })).toString("base64url")}.${signature}`;
    expect(checkGuidedSetupToken(forged, [KEY], T0 + 10_000)).toBe("invalid");
    expect(checkGuidedSetupToken(guidedSetupToken([KEY], T0 + 60_000), [KEY], T0 + 10_000)).toBe("invalid");
  });

  it("is still read after a key rotation, against every master key", () => {
    const token = guidedSetupToken([KEY], T0);
    expect(checkGuidedSetupToken(token, [OTHER, KEY], T0 + 10_000)).toBe("ok");
  });

  it("is not a GitHub or Slack state: its key is derived for this purpose alone", () => {
    const body = Buffer.from(JSON.stringify({ t: T0 })).toString("base64url");
    const plain = crypto.createHmac("sha256", KEY.key).update(`guided-setup-form.${body}`).digest("base64url");
    expect(checkGuidedSetupToken(`vx1.${body}.${plain}`, [KEY], T0 + 10_000)).toBe("invalid");
  });

  it("refuses to sign without a master key", () => {
    expect(() => guidedSetupToken([], T0)).toThrow(/no master key/);
  });
});

describe("the fields", () => {
  it("reads a full request, trimmed", () => {
    expect(guidedSetupSchema.parse(VALID)).toEqual({
      name: "Lan Pham",
      email: "lan@northwind.example",
      studio: "Northwind Studio",
      website: "https://www.northwind.example/work",
      contractors: "4-10",
      arrival: "chat",
      message: "We pay six illustrators a month.",
    });
  });

  it("takes the website and the message as optional", () => {
    const parsed = guidedSetupSchema.parse({ ...VALID, website: "", message: undefined });
    expect(parsed.website).toBeNull();
    expect(parsed.message).toBeNull();
  });

  it.each(["lan", "lan@", "@northwind.example", "lan northwind.example"])("refuses the email %s", (email) => {
    const result = guidedSetupSchema.safeParse({ ...VALID, email });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["email"]);
  });

  it.each(["northwind.example", "ftp://northwind.example", "javascript:alert(1)", "https://localhost", `https://a.example/${"x".repeat(500)}`])(
    "refuses the website %s: http(s) addresses only",
    (website) => {
      const result = guidedSetupSchema.safeParse({ ...VALID, website });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(["website"]);
    }
  );

  it("refuses a missing name or studio, an answer not on the list, and a message over 500 characters", () => {
    for (const [field, value] of [
      ["name", "  "],
      ["studio", ""],
      ["contractors", "100"],
      ["arrival", "fax"],
      ["message", "x".repeat(501)],
    ] as const) {
      const result = guidedSetupSchema.safeParse({ ...VALID, [field]: value });
      expect(result.success, field).toBe(false);
      expect(result.error?.issues[0]?.path, field).toEqual([field]);
    }
    expect(guidedSetupSchema.safeParse({ ...VALID, contractors: undefined }).success).toBe(false);
  });

  it("turns line breaks in a one-line answer into spaces", () => {
    expect(guidedSetupSchema.parse({ ...VALID, studio: "Northwind\r\nStudio" }).studio).toBe("Northwind Studio");
  });
});

describe("the lead row", () => {
  const request = guidedSetupSchema.parse(VALID);
  const touch = { utm_source: "linkedin", utm_medium: "dm", utm_campaign: "studios-oct", landing_path: "/studios", referrer_host: "www.linkedin.com" };

  it("is an inbound lead from the website form, needing review, with every column the import takes", () => {
    const lead = inboundLead(request, null, false, "2026-10-10");
    expect(Object.keys(lead).sort()).toEqual([...LEAD_CSV_HEADERS, "dedupe_key", "stage"].sort());
    expect(lead).toMatchObject({
      business_name: "Northwind Studio",
      company_url: "https://www.northwind.example/work",
      contact_channel: "website_form",
      contact_handle: "lan@northwind.example",
      signal: INBOUND_SIGNAL,
      evidence_date: "2026-10-10",
      evidence_url: null,
      segment: "other",
      source: "inbound",
      campaign_id: null,
      stage: "discovered",
      dedupe_key: "northwind.example",
      source_detail: "Guided setup form on /studios",
    });
    expect(lead.notes).toBe("Name: Lan Pham\nContractors paid a month: 4–10\nInvoices arrive by: Chat (WhatsApp, Telegram, Zalo, Slack)\nMessage: We pay six illustrators a month.");
    expect(CONTACT_CHANNELS).toContain(lead.contact_channel);
    expect(SOURCES).toContain(lead.source);
    expect(SEGMENTS).toContain(lead.segment);
  });

  it("names the campaign only when it exists, and keeps the first touch's tags either way", () => {
    const known = inboundLead(request, touch, true, "2026-10-10");
    const unknown = inboundLead(request, touch, false, "2026-10-10");
    expect(known.campaign_id).toBe("studios-oct");
    expect(unknown.campaign_id).toBeNull();
    for (const lead of [known, unknown]) {
      expect(lead.source_detail).toBe(
        "Guided setup form on /studios; first touch: utm_source=linkedin, utm_medium=dm, utm_campaign=studios-oct, landing=/studios, referrer=www.linkedin.com"
      );
    }
  });

  it("is deduplicated by the studio's name when it gives no website", () => {
    expect(inboundLead({ ...request, website: null }, null, false, "2026-10-10").dedupe_key).toBe("northwind studio");
  });

  it("leaves the message out of the notes when there is none", () => {
    expect(inboundLead({ ...request, message: null }, null, false, "2026-10-10").notes).not.toContain("Message");
  });

  it("writes no first-touch line without tags", () => {
    expect(firstTouchLine(null)).toBeNull();
    expect(firstTouchLine({})).toBeNull();
  });
});
