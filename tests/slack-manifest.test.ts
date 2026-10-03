import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ADD_INVOICE_SHORTCUT } from "@/lib/slack/interactions";
import { SLACK_SCOPES } from "@/lib/slack/oauth";

vi.mock("server-only", () => ({}));

/**
 * The Slack app as `integrations/slack/manifest.yaml` creates it (Slack design S1, S15) asks Slack for exactly what
 * the install asks for, and offers the one message shortcut the interactions route answers, at the routes that exist.
 */

const MANIFEST = readFileSync(path.join(process.cwd(), "integrations", "slack", "manifest.yaml"), "utf8");

describe("the Slack app's manifest", () => {
  it("asks for the bot scopes the install asks for, and no others", () => {
    const block = MANIFEST.split(/^\s*bot:\s*$/m)[1]?.split(/^\S/m)[0] ?? "";
    const scopes = [...block.matchAll(/^\s*-\s*([a-z:._-]+)\s*$/gm)].map((match) => match[1]);
    expect(scopes).toEqual(SLACK_SCOPES.split(","));
  });

  it("offers Add invoice to Vestiarion as a message shortcut with the callback id the route answers", () => {
    expect(MANIFEST).toMatch(/- name: Add invoice to Vestiarion\s+type: message\s+callback_id: (\S+)/);
    expect(MANIFEST.match(/- name: Add invoice to Vestiarion\s+type: message\s+callback_id: (\S+)/)?.[1]).toBe(ADD_INVOICE_SHORTCUT);
  });

  it("points at the routes Vestiarion serves", () => {
    for (const route of ["commands", "interactions", "events", "oauth"]) {
      expect(MANIFEST).toContain(`https://www.vestiarion.xyz/api/slack/${route}`);
    }
  });
});
