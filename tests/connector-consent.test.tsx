import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TermsPage from "@/app/terms/page";
import { selectProvider } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import * as consent from "@/lib/connectors/consent";
import {
  ACCOUNTANT_BOOKING_CONSENTS,
  CONSENT_HISTORY,
  CONSENT_VERSIONS,
  consentStatement,
  HOSTED_MODEL_PROVIDER,
  namesModelProvider,
} from "@/lib/connectors/consent";
import { PROVIDER_KINDS, PROVIDERS, type ProviderId } from "@/lib/connectors/provider";

/**
 * What a person agrees to before connecting a tool (src/lib/connectors/consent.ts). A connection keeps the version it
 * agreed to, so a gate on versions must take each new version whose words still cover what the gate allows: otherwise a
 * workspace that connects again quietly loses what it had. And no statement promises what the model provider does with
 * the facts it sees: that is the provider's own terms and privacy policy, which the statements and the terms page link.
 */

type Gate = { allows: string; accepts: (version: string) => boolean };

/** Every gate on consent versions consent.ts exports, by its export's name. A new gate is added here. */
const GATES: Record<string, Gate> = {
  ACCOUNTANT_BOOKING_CONSENTS: { allows: "an accountant approves bookings", accepts: (version) => ACCOUNTANT_BOOKING_CONSENTS.has(version) },
};

/** The versions at which a gate first took a provider's words. Otherwise a version is in a gate exactly when the one before it was. */
const JOINED: Record<string, readonly string[]> = {
  ACCOUNTANT_BOOKING_CONSENTS: ["xero-2026-10-13"],
};

/** consent.ts's other exports, none of them a gate. */
const NOT_GATES = ["CONSENT_VERSIONS", "CONSENT_HISTORY", "HOSTED_MODEL_PROVIDER", "namesModelProvider", "CONSENT_CHANGED", "consentStatement", "CONSENT_LABEL"];

const VERSION = /\b(?:xero|quickbooks|hubspot|pipedrive|asana)-\d{4}-\d{2}-\d{2}(?:\.\d+)?\b/;

function files(dir: string, extension: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(full, extension);
    return extension.test(entry.name) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(process.cwd(), file).split(path.sep).join("/");
const SRC = files(path.join(process.cwd(), "src"), /\.(ts|tsx)$/);

/** Whether a value holds a consent version anywhere: as a string, in an array, a Set, a Map, or an object's keys or values. */
function holdsVersion(value: unknown): boolean {
  if (typeof value === "string") return VERSION.test(value);
  if (value instanceof Map) return [...value.keys(), ...value.values()].some(holdsVersion);
  if (value instanceof Set || Array.isArray(value)) return [...value].some(holdsVersion);
  if (value && typeof value === "object") return Object.entries(value).some(([key, entry]) => VERSION.test(key) || holdsVersion(entry));
  return false;
}

/** Whether a function reads consent versions: a version in its code, or the versions or a gate by name. */
const readsVersions = (fn: (...args: never[]) => unknown) =>
  VERSION.test(fn.toString()) || /\b(?:CONSENT_VERSIONS|CONSENT_HISTORY|consentVersion|consent_version)\b/.test(fn.toString()) || Object.keys(GATES).some((name) => fn.toString().includes(name));

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

  it("knows every export of consent.ts as a gate or as not one", () => {
    expect(Object.keys(consent).sort()).toEqual([...Object.keys(GATES), ...NOT_GATES].sort());
  });

  it("holds as a gate every export that is a Set, a Map, an array or a function of versions", () => {
    for (const [name, value] of Object.entries(consent)) {
      if (name in GATES) continue;
      expect(value instanceof Set || value instanceof Map, name).toBe(false);
      if (typeof value === "function") expect(readsVersions(value as (...args: never[]) => unknown), name).toBe(false);
      // The versions themselves and their history hold versions; nothing else that is not a gate does.
      else if (name !== "CONSENT_VERSIONS" && name !== "CONSENT_HISTORY") expect(holdsVersion(value), name).toBe(false);
    }
  });

  it("keeps every consent version in src in consent.ts, so no gate is written elsewhere", () => {
    const elsewhere = SRC.map(relative)
      .filter((file) => file !== "src/lib/connectors/consent.ts")
      // The docs screenshots' fixtures stand for a stored connection, and gate nothing.
      .filter((file) => !file.startsWith("src/app/docs-shots/"))
      .filter((file) => VERSION.test(readFileSync(file, "utf8")));
    expect(elsewhere).toEqual([]);
  });

  it("lets only the connect route and the statement on the connect page read the current versions, so no 'reconnect to agree' check hides elsewhere", () => {
    const reading = (name: string) => SRC.map(relative).filter((file) => new RegExp(`\\b${name}\\b`).test(readFileSync(file, "utf8")));
    // consent.ts defines them; connect.ts checks and records the version the page showed; ConnectorConsent.tsx shows it.
    expect(reading("CONSENT_VERSIONS").sort()).toEqual(["src/components/ConnectorConsent.tsx", "src/lib/connectors/connect.ts", "src/lib/connectors/consent.ts"]);
    expect(reading("CONSENT_HISTORY")).toEqual(["src/lib/connectors/consent.ts"]);
  });

  it("is gated on nowhere in the database: a migration only checks a version's length", () => {
    const sql = files(path.join(process.cwd(), "supabase"), /\.sql$/);
    expect(sql.length).toBeGreaterThan(100);
    const uses = sql.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /consent_version/i.test(line) || VERSION.test(line))
        .map((line) => `${relative(file)}: ${line.trim()}`)
    );
    expect(uses).toEqual([
      "supabase/migrations/0101_accounting_connectors.sql: consent_version     text not null constraint accounting_connections_consent_version_check check (char_length(consent_version) between 1 and 40),",
    ]);
  });

  it.each(Object.entries(GATES))("names only versions a provider has had in %s", (name) => {
    const known = new Set(Object.values(CONSENT_HISTORY).flat());
    const value = (consent as Record<string, unknown>)[name];
    const named = value instanceof Map ? [...value.keys()] : value instanceof Set || Array.isArray(value) ? [...value] : [];
    for (const version of named) expect(known.has(String(version)), String(version)).toBe(true);
    for (const version of JOINED[name] ?? []) expect(known.has(version), version).toBe(true);
  });

  const steps = PROVIDERS.flatMap((provider) => Object.keys(GATES).map((gate) => [provider, gate] as [ProviderId, string]));
  it.each(steps)("takes each %s version in %s exactly when the one before it was in, or as it joined", (provider, name) => {
    const history = CONSENT_HISTORY[provider];
    const gate = GATES[name];
    const expected = history.map((version, index) => (JOINED[name] ?? []).includes(version) || (index > 0 && gate.accepts(history[index - 1])));
    expect(history.map((version) => gate.accepts(version))).toEqual(expected);
  });

  it("lets an accountant approve bookings on a Xero connection agreed to the current words, as under 2026-10-13", () => {
    expect(ACCOUNTANT_BOOKING_CONSENTS.has("xero-2026-10-13")).toBe(true);
    expect(ACCOUNTANT_BOOKING_CONSENTS.has(CONSENT_VERSIONS.xero)).toBe(true);
    expect(ACCOUNTANT_BOOKING_CONSENTS.has("xero-2026-10-12.2")).toBe(false);
  });
});

describe("the model provider a statement names", () => {
  it("is one the agent runs on: the hosted deployment pins it, and it is chosen when its key is the only one", () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service", DEEPSEEK_API_KEY: "key" };
    expect(selectProvider(configFromEnv({ ...env, AGENT_LLM_PROVIDER: HOSTED_MODEL_PROVIDER.id }).llm)).toBe(HOSTED_MODEL_PROVIDER.id);
    expect(selectProvider(configFromEnv(env).llm)).toBe(HOSTED_MODEL_PROVIDER.id);
    expect(readFileSync(path.join(process.cwd(), ".env.example"), "utf8")).toContain(`AGENT_LLM_PROVIDER=${HOSTED_MODEL_PROVIDER.id}`);
  });

  it("is written once, in HOSTED_MODEL_PROVIDER, and every statement takes its name from there", () => {
    expect(readFileSync(path.join(process.cwd(), "src/lib/connectors/consent.ts"), "utf8")).not.toContain(`(${HOSTED_MODEL_PROVIDER.name}, on the hosted service)`);
  });

  it.each(PROVIDERS)("%s's statement promises nothing the provider's terms do not", (provider) => {
    const words = consentStatement(provider).join(" ");
    expect(words).not.toMatch(/may not train/i);
    expect(words).not.toMatch(/(?:not|won't|will not) train on/i);
  });

  it.each(PROVIDERS)("%s's statement names the hosted provider and its own terms where the agent decides on its facts", (provider) => {
    const naming = consentStatement(provider).filter(namesModelProvider);
    const named = `The agent's model provider (${HOSTED_MODEL_PROVIDER.name}, on the hosted service)`;
    if (provider === "asana") {
      // A task's facts reach no model: a person accepts the work, and the agent decides the milestone's payment.
      expect(naming).toEqual([]);
      return;
    }
    expect(naming).toHaveLength(1);
    // A bill is decided on by the model; a deal's facts reach it only when a reminder is weighed.
    const sees = PROVIDER_KINDS[provider] === "crm" ? "may see a deal's facts to decide on its collections" : "sees each bill's facts to decide on it";
    expect(naming[0]).toContain(`${named} ${sees}, under that provider's own API terms.`);
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
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("promises nothing of the model provider's training", () => {
    expect(markup).not.toMatch(/may not train/i);
  });

  it("links the hosted provider's API terms and privacy policy for each tool whose facts the agent decides on", () => {
    // Xero, QuickBooks, Zoho Books, HubSpot, Pipedrive and Zoho CRM.
    expect(markup.match(new RegExp(`<a href="${escape(HOSTED_MODEL_PROVIDER.terms)}" target="_blank" rel="noopener noreferrer"[^>]*>API terms</a>`, "g"))).toHaveLength(6);
    expect(markup.match(new RegExp(`<a href="${escape(HOSTED_MODEL_PROVIDER.privacy)}" target="_blank" rel="noopener noreferrer"[^>]*>privacy policy</a>`, "g"))).toHaveLength(6);
    const text = markup.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(text.split(`under ${HOSTED_MODEL_PROVIDER.name}'s API terms and privacy policy.`)).toHaveLength(7);
    expect(text.split(`(${HOSTED_MODEL_PROVIDER.name}, on the hosted service) may see a deal's facts`)).toHaveLength(4);
  });
});
