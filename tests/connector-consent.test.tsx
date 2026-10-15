import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TermsPage from "@/app/terms/page";
import * as consent from "@/lib/connectors/consent";
import { ACCOUNTANT_BOOKING_CONSENTS, CONSENT_HISTORY, CONSENT_VERSIONS, consentStatement, HOSTED_MODEL_PROVIDER } from "@/lib/connectors/consent";
import { PROVIDERS, type ProviderId } from "@/lib/connectors/provider";

/**
 * What a person agrees to before connecting a tool (src/lib/connectors/consent.ts). A connection keeps the version it
 * agreed to, so a gate on versions must take each new version whose words still cover what the gate allows: otherwise a
 * workspace that connects again quietly loses what it had. And no statement promises what the model provider does with
 * the facts it sees: that is the provider's own terms, which the statements and the terms page point to.
 */

/** Every gate on consent versions, by what it allows. A new gate is added here, and the tests below hold it. */
const GATES: Record<string, ReadonlySet<string>> = {
  "an accountant approves bookings": ACCOUNTANT_BOOKING_CONSENTS,
};

const VERSION = /\b(?:xero|quickbooks|hubspot|pipedrive|asana)-\d{4}-\d{2}-\d{2}(?:\.\d+)?\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe("consent versions", () => {
  it("lists every version each provider has had, the last being the one a new connection agrees to", () => {
    expect(Object.keys(CONSENT_HISTORY).sort()).toEqual([...PROVIDERS].sort());
    for (const provider of PROVIDERS) {
      const history = CONSENT_HISTORY[provider];
      expect(history.at(-1), provider).toBe(CONSENT_VERSIONS[provider]);
      expect(new Set(history).size, provider).toBe(history.length);
      for (const version of history) expect(version.startsWith(`${provider}-`), version).toBe(true);
    }
  });

  it("names every set of versions consent.ts exports among the gates held here", () => {
    const sets = Object.entries(consent).filter(([, value]) => value instanceof Set);
    expect(sets.length).toBeGreaterThan(0);
    for (const [name, value] of sets) expect(Object.values(GATES), name).toContain(value);
  });

  it("keeps every consent version in src in consent.ts, so no gate is written elsewhere", () => {
    const src = path.join(process.cwd(), "src");
    const elsewhere = sourceFiles(src)
      .filter((file) => !file.endsWith(path.join("connectors", "consent.ts")))
      // The docs screenshots' fixtures stand for a stored connection, and gate nothing.
      .filter((file) => !file.includes(`${path.sep}docs-shots${path.sep}`))
      .filter((file) => VERSION.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(process.cwd(), file));
    expect(elsewhere).toEqual([]);
  });

  it.each(Object.entries(GATES))("names only versions a provider has had in the gate where %s", (_, gate) => {
    const known = new Set(Object.values(CONSENT_HISTORY).flat());
    for (const version of gate) expect(known.has(version), version).toBe(true);
  });

  const steps = PROVIDERS.flatMap((provider) =>
    Object.entries(GATES).map(([gate, versions]) => [provider, gate, versions] as [ProviderId, string, ReadonlySet<string>])
  );
  it.each(steps)("takes %s's current version where %s, if it took the version before", (provider, _, gate) => {
    const history = CONSENT_HISTORY[provider];
    const previous = history.at(-2);
    if (previous !== undefined && gate.has(previous)) expect(gate.has(CONSENT_VERSIONS[provider])).toBe(true);
  });

  it("lets an accountant approve bookings on a Xero connection agreed to the current words, as under 2026-10-13", () => {
    expect(ACCOUNTANT_BOOKING_CONSENTS.has("xero-2026-10-13")).toBe(true);
    expect(ACCOUNTANT_BOOKING_CONSENTS.has(CONSENT_VERSIONS.xero)).toBe(true);
    expect(ACCOUNTANT_BOOKING_CONSENTS.has("xero-2026-10-12.2")).toBe(false);
  });
});

describe("what a statement says of the model provider", () => {
  it.each(PROVIDERS)("%s's promises nothing the provider's terms do not", (provider) => {
    const words = consentStatement(provider).join(" ");
    expect(words).not.toMatch(/may not train/i);
    expect(words).not.toMatch(/(?:not|won't|will not) train on/i);
  });

  it.each(PROVIDERS.filter((provider) => consentStatement(provider).some((line) => line.includes("model provider"))))(
    "%s's names the hosted service's provider and its own API terms",
    (provider) => {
      const words = consentStatement(provider).join(" ");
      expect(words).toContain(`The agent's model provider (${HOSTED_MODEL_PROVIDER.name}, on the hosted service) sees`);
      expect(words).toContain("under that provider's own API terms.");
    }
  );

  it("is said of every bill and deal a provider brings in", () => {
    for (const provider of ["xero", "quickbooks", "hubspot", "pipedrive"] as const) {
      expect(consentStatement(provider).some((line) => line.includes("model provider")), provider).toBe(true);
    }
  });
});

describe("the connector guides", () => {
  const guides = path.join(process.cwd(), "content", "docs", "guides");

  it.each(readdirSync(guides).filter((file) => file.endsWith(".mdx")))("%s promises nothing of the model provider's training", (file) => {
    expect(readFileSync(path.join(guides, file), "utf8")).not.toMatch(/may not train|(?:not|won't|will not) train on/i);
  });
});

describe("the terms page on connected tools", () => {
  const markup = renderToStaticMarkup(<TermsPage />);

  it("promises nothing of the model provider's training, and links the hosted provider's terms", () => {
    expect(markup).not.toMatch(/may not train/i);
    expect(markup).toMatch(new RegExp(`<a [^>]*href="${HOSTED_MODEL_PROVIDER.terms.replace(/[.]/g, "\\.")}"[^>]*target="_blank"`));
    // Xero, QuickBooks, HubSpot and Pipedrive: each tool whose facts the agent decides on.
    expect(markup.match(/that provider&#x27;s own API terms<\/a>/g)?.length).toBe(4);
  });
});
