import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackRoute } from "@/app/api/integrations/jira/callback/route";
import { POST as chooseRoute } from "@/app/api/integrations/jira/choose/route";
import { POST as connectRoute } from "@/app/api/integrations/jira/connect/route";
import { POST as webhookRoute } from "@/app/api/integrations/jira/webhook/route";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { BOOKS_PAYMENTS, PICKS_PAYMENT_ACCOUNT } from "@/lib/connectors/booking";
import { chooseConnect, finishConnect, startConnect, type ConnectDeps } from "@/lib/connectors/connect";
import { ConnectRefusal } from "@/lib/connectors/connect-refusal";
import { CONSENT_HISTORY, CONSENT_VERSIONS, consentStatement, namesModelProvider } from "@/lib/connectors/consent";
import { PROVIDER_KINDS, PROVIDER_LABELS, PROVIDER_WORDS, providerKind, PROVIDERS, providerWords, UNMARKED_PROVIDERS } from "@/lib/connectors/provider";
import { connectState, readConnectState } from "@/lib/connectors/state";
import { connectionStatus, syncErrorWords, type ConnectionFacts } from "@/lib/connectors/status";
import { jiraConnectDeps } from "@/lib/jira/connect-deps";
import { jiraProvider } from "@/lib/jira/provider";
import { parseMasterKeys } from "@/lib/secrets";
import { actionLabel } from "@/lib/usage/model";
import { memoryPostgrest, type Row } from "./support/memory-postgrest";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Jira on the connector core (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR2, JR3, JR22): a work
 * tool, as Linear is, on one Jira site, that books nothing and brings no bills or deals in; its words for a site and its
 * linked issues; the reconnect words that name the Atlassian account and the 90 days; its statement; and `no_site`, the
 * refusal of a grant that reaches no Jira site.
 *
 * Then connecting, through the connector core's flow with Jira's own OAuth calls and `jiraConnectDeps`, over a PostgREST
 * in memory and a fake Atlassian: only an owner or admin who agreed goes to Atlassian's consent screen; on the way back
 * the code is exchanged, and the Jira sites the grant reaches decide what happens. One is connected, its tokens sealed
 * apart, and once the answer is sent the first upkeep saves its site row; several are offered, kept as a pending grant
 * for ten minutes, and the one chosen is connected; none is refused as `no_site`, keeping nothing. Not exclusive: no
 * other workspace is asked about. Before migration 0149 no one is sent to Atlassian, and while `JIRA_CLIENT_ID` and
 * `JIRA_CLIENT_SECRET` are not both set, none of the four routes is there.
 */

const { mocks } = vi.hoisted(() => ({ mocks: { session: vi.fn(), membership: vi.fn() } }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: mocks.membership }));

const NOW = Date.parse("2026-11-09T08:00:00.000Z");
const RECONNECT_WORDS =
  "Jira no longer accepts this connection: the app's access was removed in the Atlassian account, or it went unused for 90 days. Reconnect Jira to go on reading the issues linked to milestones.";

const facts = (overrides: Partial<ConnectionFacts>): ConnectionFacts => ({
  providerLabel: "Jira",
  status: "connected",
  externalOrgName: "Northstar",
  lastSyncedAt: null,
  lastError: null,
  lastErrorAt: null,
  syncing: null,
  ...overrides,
});

describe("Jira on the connector core (Jira acceptance JR1)", () => {
  it("is a work tool named Jira, the last provider, with no mark of its own, its consent first agreed on 2026-11-09", () => {
    expect(PROVIDERS.at(-1)).toBe("jira");
    expect(PROVIDER_LABELS.jira).toBe("Jira");
    expect(PROVIDER_KINDS.jira).toBe("work");
    expect(providerKind("Jira")).toBe("work");
    expect(UNMARKED_PROVIDERS).toContain("jira");
    expect(CONSENT_VERSIONS.jira).toBe("jira-2026-11-09");
    expect(CONSENT_HISTORY.jira).toEqual(["jira-2026-11-09"]);
    expect(actionLabel("jira")).toBe("Jira");
  });

  it("speaks of a site and its linked issues, and books nothing", () => {
    expect(PROVIDER_WORDS.jira).toEqual({
      possessive: "Jira's",
      organisation: "site",
      contacts: "users",
      accounts: "no accounts",
      idleDays: 90,
      bills: "linked issues",
      approval: "An issue done in Jira is never by itself a reason to pay: a person accepts the work against its criteria.",
      workItem: "issue",
      revokedIn: "the Atlassian account",
    });
    expect(providerWords("Jira")).toBe(PROVIDER_WORDS.jira);
    expect(BOOKS_PAYMENTS.jira).toBe(false);
    expect(PICKS_PAYMENT_ACCOUNT.jira).toBe(false);
  });

  it("says to reconnect in Jira's words, naming the Atlassian account and the 90 days, and leaves Linear's and Asana's as they were (JR3)", () => {
    expect(syncErrorWords("reconnect", "Jira", null)).toBe(RECONNECT_WORDS);
    expect(syncErrorWords("reconnect", "Linear", null)).toBe(
      "Linear no longer accepts this connection: the app's access was removed in Linear. Reconnect Linear to go on reading the issues linked to milestones."
    );
    expect(syncErrorWords("reconnect", "Asana", null)).toBe(
      "Asana no longer accepts this connection: the app's access was removed in Asana. Reconnect Asana to go on reading the tasks linked to milestones."
    );
    // The card of a connection to reconnect says the same when the sweep left no words of its own.
    expect(connectionStatus(facts({ status: "needs_reconnect" }), NOW)).toEqual({ tone: "error", title: "Jira needs you to reconnect", detail: [RECONNECT_WORDS], reconnect: true });
    expect(syncErrorWords("rate_limited", "Jira", "2026-11-09T08:05:00.000Z", NOW)).toBe("Jira asked Vestiarion to slow down. Syncing again at 08:05 UTC.");
    expect(syncErrorWords("bad_response", "Jira", "2026-11-09T08:15:00.000Z", NOW)).toBe("Jira's answer could not be read. Vestiarion tries again at 08:15 UTC.");
  });

  it("keeps the acceptances recorded once disconnected, and names the site it was connected to", () => {
    expect(connectionStatus(facts({ status: "revoked" }), NOW)).toEqual({
      tone: "off",
      title: "Disconnected from Northstar",
      detail: ["Acceptances already recorded stay in Vestiarion. Nothing more is read from Jira."],
      reconnect: false,
    });
    expect(connectionStatus(facts({ status: "revoked", externalOrgName: null }), NOW).title).toBe("Disconnected from your Jira site");
  });

  it("refuses a grant that reaches no Jira site in its own outcome, which the callback sends back as ?jira=no_site (JR2)", () => {
    const refusal = new ConnectRefusal("no_site");
    expect(refusal.outcome).toBe("no_site");
    expect(refusal.message).toBe("connect refused: no_site");
    expect(refusal.name).toBe("ConnectRefusal");
    expect(new ConnectRefusal("scopes").outcome).toBe("scopes");
  });
});

describe("Jira's statement (JR2, JR4, JR12, JR14, JR18, JR19)", () => {
  const lines = consentStatement("jira");
  const words = lines.join(" ");

  it("is seven lines, and names no model provider: an issue's facts reach no model", () => {
    expect(lines).toHaveLength(7);
    expect(lines.filter(namesModelProvider)).toEqual([]);
    // A copy each time, so no caller changes the words another shows.
    expect(consentStatement("jira")).not.toBe(lines);
  });

  it("reads as the person who connects, on one site, and checks the site once a day", () => {
    expect(lines[0]).toBe(
      "Vestiarion reads Jira as the Atlassian user who connects, on the one Jira site you connect, and sees the issues that person can see there. It reads the site's name and address when you connect, and checks once a day that the connection still reaches the site."
    );
  });

  it("says what is read of a linked issue, that deliverables are read once it is done, and that no Atlassian person data is kept", () => {
    expect(lines[1]).toContain("once the issue is done, also its attachments' names, its web links, and the links in its description and its newest 50 comments");
    expect(lines[1]).toContain("A deliverable that links to another issue on the site is checked at Jira to see that it opens.");
    expect(lines[1]).toContain("It keeps the links and names, not the words of the description or the comments, and keeps no Atlassian account ID, name or email.");
    expect(lines[2]).toBe(
      "When a person accepts the work, it asks Jira which Atlassian account has the payee's email, and which is that person's own, only to refuse an acceptance by the payee. It sends Jira those email addresses for that, and keeps neither them nor the answer."
    );
  });

  it("names the one webhook it makes and deletes, that a notice only has an issue read again, and that it writes nothing else", () => {
    expect(lines[3]).toContain("It makes one webhook on the site for the projects of the linked issues");
    expect(lines[3]).toContain("renews it before Jira lets it lapse, and deletes it when no linked issue is left open or Jira is disconnected");
    expect(lines[3]).toContain("What a notice says is never used as it is: Vestiarion reads the issue again from Jira. It writes nothing else to Jira.");
  });

  it("says nothing from Jira pays, and how to end the access at Atlassian, which gives apps no way to end their own", () => {
    expect(lines[4]).toBe(
      "An issue done in Jira is never by itself a reason to pay: a person here accepts the work against the milestone's criteria, and the agent then decides the payment under every guardrail. Nothing from Jira sets an amount or a payee."
    );
    expect(lines[5]).toBe("Vestiarion never uses Jira data to train or improve any AI model, and never passes it to anyone else without your workspace's say.");
    expect(lines[6]).toBe(
      "Disconnecting stops the reading at once, and deletes the webhook and the tokens. Atlassian gives apps no way to end their own access, so remove Vestiarion from Connected apps in your Atlassian account settings to end it there too. Acceptances already recorded stay in Vestiarion's signed ledger."
    );
    // Unlike Linear's, it never says the access is revoked at Jira: no request can do that (JR4).
    expect(words).not.toMatch(/revokes Vestiarion's access/);
  });
});

/*
 * Connecting (JR2): the connector core's flow, Jira's own calls, and the first upkeep after the answer.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1c01";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1c02";
const CONN = "dddddddd-0000-4000-8000-00000000d1c1";
/** Northstar's cloudId, and Southwind's, a second site the same Atlassian account reaches. */
const CLOUD = "4f6c3a2e-8b1d-4e7a-9c2f-1a0b3c4d5e6f";
const SOUTHWIND = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ORIGIN = "https://www.vestiarion.xyz";
const REDIRECT = `${ORIGIN}/api/integrations/jira/callback`;
const SETTINGS = { clientId: "Zp3cQ8mW1xYk7RtA2nV5bL9dF4gH6jK0", clientSecret: "ATOA-the-secret-of-the-app" };
const SCOPES = ["read:jira-work", "read:jira-user", "manage:jira-webhook", "offline_access"];
const CONSENT = { version: CONSENT_VERSIONS.jira, at: "2026-11-09T07:59:00.000Z" };
const NONCE = "n".repeat(43);
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const keys = () => parseMasterKeys(process.env.VESTIARION_MASTER_KEYS);

interface AtlassianSite {
  id: string;
  name: string;
  url: string;
  scopes: string[];
}
const NORTHSTAR: AtlassianSite = { id: CLOUD, name: "Northstar", url: "https://northstar.atlassian.net", scopes: ["read:jira-work", "read:jira-user", "manage:jira-webhook"] };
const SOUTHWIND_SITE: AtlassianSite = { id: SOUTHWIND, name: "Southwind", url: "https://southwind.atlassian.net", scopes: ["read:jira-work", "read:jira-user", "manage:jira-webhook"] };
/** A Confluence site the same grant reaches: Atlassian lists it too, and it is no Jira site. */
const CONFLUENCE: AtlassianSite = { id: "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b", name: "Northstar wiki", url: "https://northstar.atlassian.net", scopes: ["read:confluence-content.all"] };

const connectionRow = (fields: Row = {}): Row => ({
  id: CONN, org_id: ORG, provider: "jira", external_org_id: CLOUD, external_org_name: "Northstar", status: "connected", scopes: SCOPES, connected_by: USER,
  connected_at: "2026-11-01T08:00:00Z", consent_version: CONSENT.version, consented_at: "2026-11-01T07:59:00Z", revoked_at: null, revoked_by: null, window_from: "2026-08-03",
  last_synced_at: null, last_error: null, last_error_at: null, failures: 0, next_sync_after: null, sync_lease_until: null, payment_account: null, payment_account_at: null,
  created_at: "2026-11-01T08:00:00Z", ...fields,
});
const siteRow = (fields: Row = {}): Row => ({
  connection_id: CONN, org_id: ORG, cloud_id: CLOUD, site_url: "https://northstar.atlassian.net", webhook_ids: [], retired_webhook_ids: [], retired_until: null,
  webhook_jql: null, webhook_expires_at: null, webhook_registered_at: null, webhook_checked_at: "2026-11-01T08:00:00.000Z", webhook_error: null, last_delivery_at: null,
  missed_change_at: null, site_missing_at: null, updated_at: "2026-11-01T08:00:00.000Z", ...fields,
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.session.mockResolvedValue({ id: USER, email: null });
  mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "owner", network: "arc-testnet" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function world(options: { sites?: AtlassianSite[]; seed?: Record<string, Row[]>; migrated?: boolean } = {}) {
  const sites = options.sites ?? [NORTHSTAR];
  const entries: Row[] = [];
  const database = memoryPostgrest({
    specs: {
      accounting_connections: { defaults: () => ({ id: crypto.randomUUID(), last_synced_at: null, payment_account: null, payment_account_at: null, created_at: new Date().toISOString() }) },
      accounting_tokens: { defaults: () => ({ version: 1 }) },
      jira_sites: {
        unique: [["connection_id"]],
        defaults: () => ({
          webhook_ids: [], retired_webhook_ids: [], retired_until: null, webhook_jql: null, webhook_expires_at: null, webhook_registered_at: null, webhook_checked_at: null,
          webhook_error: null, last_delivery_at: null, missed_change_at: null, site_missing_at: null, updated_at: new Date().toISOString(),
        }),
      },
    },
    seed: { orgs: [orgs.orgRow(ORG, { slug: "acme" })], accounting_connections: [], accounting_tokens: [], jira_sites: [], jira_issue_links: [], milestones: [], ...options.seed },
    rpc: {
      append_ledger_entry: (args) => {
        entries.push(args);
        return { body: APPENDED_LEDGER_ROW };
      },
      // Before migration 0149 its probe is not there, as PostgREST says of a function it does not know (PGRST202).
      ...(options.migrated === false ? {} : { jira_connector_ready: () => ({ body: true }) }),
    },
  });

  // Atlassian: the token endpoint, and the sites a token reaches. Any other call is recorded, and none is expected.
  const atlassian = { calls: [] as Array<{ method: string; url: string; authorization: string | null; body: unknown }> };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    atlassian.calls.push({ method, url, authorization: new Headers(init?.headers).get("authorization"), body });
    if (url === "https://auth.atlassian.com/oauth/token" && body?.grant_type === "authorization_code" && body.code === "the-code") {
      return json({ access_token: "jira_access_1", refresh_token: "jira_refresh_1", expires_in: 3600, scope: SCOPES.join(" "), token_type: "Bearer" });
    }
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") {
      return json(sites.map((site) => ({ ...site, avatarUrl: "https://site-admin-avatar-cdn.prod.public.atl-paas.net/avatars/240/rocket.png" })));
    }
    return json({ errorMessages: ["Unknown"] }, 404);
  }) as unknown as typeof fetch;

  const provider = jiraProvider(SETTINGS, { fetchImpl, pause: { until: 0 } });
  const later: Array<() => Promise<void>> = [];
  const deps = (): ConnectDeps => ({ ...jiraConnectDeps(SETTINGS, provider), origin: ORIGIN, keys: keys(), now: () => NOW, afterConnect: (work) => later.push(work) });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: database.client, fetch: database.fetch }, fn);
  return { database, atlassian, entries, later, deps, run, rows: (table: string) => database.rows(table) };
}

type World = ReturnType<typeof world>;
const location = (response: Response) => new URL(response.headers.get("location") ?? "", ORIGIN);
const form = (path: string, fields: Record<string, string>, origin: string | null = ORIGIN) =>
  new Request(`${ORIGIN}/api/integrations/jira/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) },
    body: new URLSearchParams(fields).toString(),
  });
const agreed = () => form("connect", { org: "acme", consent: "yes", consent_version: CONSENT_VERSIONS.jira });
const callback = (query: Record<string, string>, nonce: string | null) =>
  new Request(`${REDIRECT}?${new URLSearchParams(query).toString()}`, { headers: nonce ? { cookie: `vx_jira_oauth=${nonce}` } : {} });
const signed = () => connectState({ provider: "jira", org: ORG, user: USER, nonce: NONCE, consent: CONSENT }, keys(), NOW);
const comeBack = (w: World) => w.run(() => finishConnect(callback({ code: "the-code", state: signed() }, NONCE), w.deps()));
/** The Atlassian calls, as `METHOD url`. */
const callsOf = (w: World) => w.atlassian.calls.map((call) => `${call.method} ${call.url}`);
const RESOURCES = "GET https://api.atlassian.com/oauth/token/accessible-resources";

describe("startConnect for Jira (JR2)", () => {
  it("sends an owner who agreed to Atlassian's consent screen with exactly its seven parameters and a signed state, in the vx_jira_oauth cookie", async () => {
    const w = world();
    const response = await w.run(() => startConnect(agreed(), w.deps()));
    expect(response.status).toBe(303);
    const to = location(response);
    expect(`${to.origin}${to.pathname}`).toBe("https://auth.atlassian.com/authorize");
    expect([...to.searchParams.keys()]).toEqual(["audience", "client_id", "scope", "redirect_uri", "state", "response_type", "prompt"]);
    expect(to.searchParams.get("audience")).toBe("api.atlassian.com");
    expect(to.searchParams.get("client_id")).toBe(SETTINGS.clientId);
    expect(to.searchParams.get("scope")).toBe("read:jira-work read:jira-user manage:jira-webhook offline_access");
    expect(to.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(to.searchParams.get("response_type")).toBe("code");
    expect(to.searchParams.get("prompt")).toBe("consent");
    expect(to.toString()).not.toContain(SETTINGS.clientSecret);
    const state = readConnectState(to.searchParams.get("state") ?? "", keys(), NOW);
    expect(state).toMatchObject({ provider: "jira", org: ORG, user: USER, consent: { version: "jira-2026-11-09", at: "2026-11-09T08:00:00.000Z" } });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`vx_jira_oauth=${state?.nonce}`);
    expect(cookie).toContain("Path=/api/integrations/jira");
    expect(cookie).toMatch(/HttpOnly/);
    // Nothing is asked of Atlassian before the person comes back.
    expect(w.atlassian.calls).toEqual([]);
  });

  it("sends a member who may not manage integrations back, and no one before migration 0149 (JR5)", async () => {
    const w = world();
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "approver", network: "arc-testnet" });
    expect(location(await w.run(() => startConnect(agreed(), w.deps()))).toString()).toBe(`${ORIGIN}/integrations/jira/connect?org=acme&error=forbidden`);
    mocks.membership.mockResolvedValue({ orgId: ORG, slug: "acme", name: "Acme", mode: "sandbox", role: "owner", network: "arc-testnet" });
    const before = world({ migrated: false });
    const response = await before.run(() => startConnect(agreed(), before.deps()));
    expect(location(response).toString()).toBe(`${ORIGIN}/integrations/jira/connect?org=acme&error=not_set_up`);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(before.atlassian.calls).toEqual([]);
  });
});

describe("finishConnect for Jira (JR2, JR3)", () => {
  it("connects the one Jira site the grant reaches, by its cloudId and name, its tokens sealed apart; the first upkeep after the answer saves its site row", async () => {
    const w = world({ sites: [NORTHSTAR, CONFLUENCE] });
    const response = await comeBack(w);
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?jira=connected#jira`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    // The code exchanged with a JSON body, the client's credentials in it, never in the address; then the sites read.
    expect(callsOf(w)).toEqual(["POST https://auth.atlassian.com/oauth/token", RESOURCES]);
    expect(w.atlassian.calls[0].body).toEqual({ grant_type: "authorization_code", code: "the-code", redirect_uri: REDIRECT, client_id: SETTINGS.clientId, client_secret: SETTINGS.clientSecret });
    expect(w.atlassian.calls[1].authorization).toBe("Bearer jira_access_1");
    // Not exclusive: no other workspace is asked about.
    expect(w.database.requests.some((sent) => sent.path === "/rest/v1/rpc/accounting_connections_by_external")).toBe(false);

    expect(w.rows("accounting_connections")).toHaveLength(1);
    const [connection] = w.rows("accounting_connections");
    expect(connection).toMatchObject({
      org_id: ORG, provider: "jira", external_org_id: CLOUD, external_org_name: "Northstar", status: "connected", connected_by: USER, consent_version: "jira-2026-11-09",
      consented_at: CONSENT.at, scopes: SCOPES,
    });
    expect(w.rows("accounting_tokens")).toEqual([expect.objectContaining({ org_id: ORG, provider: "jira", connection_id: connection.id, authorized_by: USER, choices: null, choose_until: null })]);
    expect(JSON.stringify(w.rows("accounting_tokens"))).not.toMatch(/jira_access_1|jira_refresh_1/);
    expect(w.entries).toHaveLength(1);
    expect(w.entries[0]).toMatchObject({ p_action: "accounting_connected", p_actor: "human", p_domain: "system" });
    expect(w.entries[0].p_summary).toBe("Connected Jira: Northstar. Its issues can be linked to milestones on Contractors");
    expect(w.entries[0].p_detail).toEqual({
      by: USER, provider: "jira", connectionId: connection.id, externalOrgId: CLOUD, externalOrgName: "Northstar", scopes: SCOPES, consent: CONSENT, reconnected: false,
    });

    // The first upkeep runs once the answer is sent, with the connection's own sealed token: the site row saved, the
    // keep-alive asked, and no webhook while no milestone is linked to one of its issues (JR2, JR14).
    expect(w.rows("jira_sites")).toEqual([]);
    expect(w.later).toHaveLength(1);
    await w.run(() => w.later[0]());
    expect(w.rows("jira_sites")).toEqual([
      expect.objectContaining({ connection_id: connection.id, org_id: ORG, cloud_id: CLOUD, site_url: "https://northstar.atlassian.net", webhook_ids: [], webhook_jql: null, site_missing_at: null }),
    ]);
    expect(w.rows("jira_sites")[0].webhook_checked_at).toEqual(expect.any(String));
    expect(callsOf(w).slice(2)).toEqual([RESOURCES]);
    expect(w.atlassian.calls[2].authorization).toBe("Bearer jira_access_1");
  });

  it("offers the sites to choose from when the grant reaches several, keeping its tokens ten minutes; the site chosen is connected, and its row saved after the answer", async () => {
    const w = world({ sites: [NORTHSTAR, SOUTHWIND_SITE] });
    const to = location(await comeBack(w));
    expect(to.pathname).toBe("/integrations/jira/connect");
    expect(Object.fromEntries(to.searchParams)).toEqual({ org: "acme", choose: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const choice = to.searchParams.get("choose") ?? "";
    expect(w.rows("accounting_tokens")).toEqual([
      expect.objectContaining({
        id: choice, provider: "jira", connection_id: null, authorized_by: USER, choose_until: "2026-11-09T08:10:00.000Z",
        choices: {
          organisations: [
            { externalOrgId: CLOUD, name: "Northstar", connectionId: null },
            { externalOrgId: SOUTHWIND, name: "Southwind", connectionId: null },
          ],
          consent: CONSENT,
        },
      }),
    ]);
    expect(JSON.stringify(w.rows("accounting_tokens"))).not.toMatch(/jira_access_1|jira_refresh_1/);
    expect(w.rows("accounting_connections")).toEqual([]);
    expect(w.later).toEqual([]);

    // A site the grant did not offer is asked again; the one picked is connected with the pending grant's tokens.
    const odd = await w.run(() => chooseConnect(form("choose", { org: "acme", choice, organisation: "11111111-2222-4333-8444-555555555555" }), w.deps()));
    expect(location(odd).searchParams.get("error")).toBe("pick");
    expect(w.rows("accounting_connections")).toEqual([]);
    const chosen = await w.run(() => chooseConnect(form("choose", { org: "acme", choice, organisation: SOUTHWIND }), w.deps()));
    expect(location(chosen).toString()).toBe(`${ORIGIN}/o/acme/settings?jira=connected#jira`);
    const [connection] = w.rows("accounting_connections");
    expect(connection).toMatchObject({ provider: "jira", external_org_id: SOUTHWIND, external_org_name: "Southwind", consent_version: "jira-2026-11-09", scopes: SCOPES });
    expect(w.rows("accounting_tokens")).toEqual([expect.objectContaining({ id: choice, connection_id: connection.id, choices: null, choose_until: null })]);
    expect(w.entries[0].p_summary).toBe("Connected Jira: Southwind. Its issues can be linked to milestones on Contractors");
    expect(w.later).toHaveLength(1);
    await w.run(() => w.later[0]());
    expect(w.rows("jira_sites")).toEqual([expect.objectContaining({ connection_id: connection.id, cloud_id: SOUTHWIND, site_url: "https://southwind.atlassian.net" })]);
  });

  it("refuses a grant that reaches no Jira site as no_site, and keeps nothing: no connection, no tokens, no entry", async () => {
    const w = world({ sites: [CONFLUENCE] });
    const response = await comeBack(w);
    expect(location(response).toString()).toBe(`${ORIGIN}/o/acme/settings?jira=no_site#jira`);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(w.rows("accounting_connections")).toEqual([]);
    expect(w.rows("accounting_tokens")).toEqual([]);
    expect(w.rows("jira_sites")).toEqual([]);
    expect(w.entries).toEqual([]);
    expect(w.later).toEqual([]);
  });

  it("refuses another site while one is connected, and keeps the connection row and its site row when the same site is connected again", async () => {
    const other = world({ seed: { accounting_connections: [connectionRow({ external_org_id: SOUTHWIND, external_org_name: "Southwind" })] } });
    expect(location(await comeBack(other)).toString()).toBe(`${ORIGIN}/o/acme/settings?jira=other_organisation#jira`);
    expect(other.rows("accounting_tokens")).toEqual([]);

    const again = world({ seed: { accounting_connections: [connectionRow({ status: "needs_reconnect", last_error: RECONNECT_WORDS })], jira_sites: [siteRow()] } });
    expect(location(await comeBack(again)).toString()).toBe(`${ORIGIN}/o/acme/settings?jira=connected#jira`);
    expect(again.rows("accounting_connections")).toEqual([expect.objectContaining({ id: CONN, status: "connected", last_error: null })]);
    expect(again.entries[0].p_detail).toMatchObject({ connectionId: CONN, reconnected: true });
    await again.run(() => again.later[0]());
    expect(again.rows("jira_sites")).toEqual([expect.objectContaining({ connection_id: CONN, cloud_id: CLOUD, site_url: "https://northstar.atlassian.net" })]);
  });
});

describe("the routes (JR1)", () => {
  const requests = () => ({
    connect: agreed(),
    callback: new Request(`${REDIRECT}?code=c&state=s`),
    choose: form("choose", { org: "acme", choice: crypto.randomUUID(), organisation: CLOUD }),
    webhook: new Request(`${ORIGIN}/api/integrations/jira/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  });

  it("are not there unless both JIRA_CLIENT_ID and JIRA_CLIENT_SECRET are set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const env of [
      { id: "", secret: "" },
      { id: SETTINGS.clientId, secret: "" },
      { id: "", secret: SETTINGS.clientSecret },
    ]) {
      vi.stubEnv("JIRA_CLIENT_ID", env.id);
      vi.stubEnv("JIRA_CLIENT_SECRET", env.secret);
      const sent = requests();
      const answers: Array<[string, Response]> = [
        ["connect", await connectRoute(sent.connect)],
        ["callback", await callbackRoute(sent.callback)],
        ["choose", await chooseRoute(sent.choose)],
        ["webhook", await webhookRoute(sent.webhook)],
      ];
      for (const [name, response] of answers) {
        expect(response.status, `${name} ${JSON.stringify(env)}`).toBe(404);
        expect(await response.json()).toEqual({ error: "not_found" });
      }
    }
    expect(mocks.session).not.toHaveBeenCalled();
  });

  it("run the connector core's flow and the delivery's check once both are set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("JIRA_CLIENT_ID", SETTINGS.clientId);
    vi.stubEnv("JIRA_CLIENT_SECRET", SETTINGS.clientSecret);
    // A form from no page of this deployment is refused before anything is read.
    expect((await connectRoute(form("connect", { org: "acme", consent: "yes" }, null))).status).toBe(403);
    expect((await chooseRoute(form("choose", { org: "acme", choice: crypto.randomUUID(), organisation: CLOUD }, null))).status).toBe(403);
    // A way back with no state of ours goes to the connect page, nothing exchanged.
    const installed = await callbackRoute(new Request(`${REDIRECT}?code=c`));
    expect(installed.status).toBe(302);
    expect(new URL(installed.headers.get("location") ?? "").pathname).toBe("/integrations/jira/connect");
    // A delivery with no token is refused before its body is read.
    expect((await webhookRoute(requests().webhook)).status).toBe(401);
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
