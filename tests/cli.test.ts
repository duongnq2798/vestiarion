import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";
import { configPath } from "../cli/src/config";
import { COMMANDS } from "../cli/src/main";
import { VERSION } from "../cli/src/version";
import { harness, KEY, OTHER_KEY, recorded, SECRET, THIRD_KEY, type Harness } from "./support/cli-harness";

/** The CLI (`@vestiarion/cli`, cli/) against a recorded API: its commands, auth, output, confirmations and exit codes. */

const ENV_KEY = { VESTIARION_API_KEY: KEY };
const ok = (name: string) => ({ status: 200, body: recorded(name) });
const apiError = (status: number, code: string, message: string, headers?: Record<string, string>) => ({ status, body: { error: { code, message } }, headers });

function saveProfiles(h: Harness, profiles: Record<string, { apiKey: string; baseUrl?: string }>) {
  const file = configPath(h.io);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ profiles }));
  return file;
}

const query = (h: Harness, index = 0) => Object.fromEntries(new URL(h.sent[index].url).searchParams);

describe("help and arguments", () => {
  it("prints its help, the commands, the exit codes and its version", async () => {
    const h = harness();
    expect(await h.run("--help")).toBe(0);
    for (const word of ["login", "whoami", "bills", "invoices", "counterparties", "milestones", "decisions", "ledger", "webhooks", "Exit codes"]) {
      expect(h.stdout).toContain(word);
    }
    expect(h.stderr).toBe("");
    const v = harness();
    expect(await v.run("--version")).toBe(0);
    expect(v.stdout).toBe(`${VERSION}\n`);
    expect(VERSION).toBe(JSON.parse(readFileSync("cli/package.json", "utf8")).version);
  });

  it("prints the help when run with nothing, and a group's commands when given only the group", async () => {
    const bare = harness();
    expect(await bare.run()).toBe(0);
    expect(bare.stdout).toContain("Usage: vestiarion <command>");
    const group = harness();
    expect(await group.run("bills")).toBe(0);
    expect(group.stdout).toContain("vestiarion bills list");
    expect(group.stdout).toContain("vestiarion bills add");
  });

  it.each(COMMANDS.map((command) => [command.path.join(" ")]))("`%s --help` shows its usage, options and exit codes, and sends nothing", async (name) => {
    const h = harness({ env: ENV_KEY });
    expect(await h.run(...name.split(" "), "--help")).toBe(0);
    expect(h.stdout).toContain(`Usage: vestiarion ${name}`);
    expect(h.stdout).toContain("Exit codes:");
    expect(h.sent).toEqual([]);
    const viaHelp = harness();
    await viaHelp.run("help", ...name.split(" "));
    expect(viaHelp.stdout).toBe(h.stdout);
  });

  it("names, for every command that calls the API, an operation the API has: no invented endpoint", () => {
    const doc = buildOpenApiDocument("https://www.vestiarion.xyz") as unknown as { paths: Record<string, Record<string, unknown>> };
    const routes = new Set(Object.entries(doc.paths).flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${route}`)));
    let named = 0;
    for (const command of COMMANDS) {
      const text = (command.description ?? []).join(" ");
      for (const [, method, route] of text.matchAll(/\b(GET|POST) (\/api\/v1\/[\w/{}-]+)/g)) {
        expect(routes, `${command.path.join(" ")}: ${method} ${route}`).toContain(`${method} ${route}`);
        named += 1;
      }
      if (!command.offline) expect(text, command.path.join(" ")).toMatch(/\b(GET|POST) \/api\/v1\//);
    }
    expect(named).toBeGreaterThan(15);
  });

  it.each([
    [["frobnicate"], /no command "frobnicate"/],
    [["bills", "frob"], /no command "bills frob"/],
    [["bills", "list", "--bogus"], /Unknown option '--bogus'/],
    [["bills", "list", "extra"], /takes no arguments/],
    [["bills", "show"], /takes <id>/],
    [["bills", "list", "--limit", "0"], /--limit must be a whole number/],
    [["bills", "list", "--limit", "ten"], /--limit must be a whole number/],
    [["bills", "add", "--amount", "1", "--due", "2026-10-31", "--yes"], /--counterparty is required/],
    [["bills", "add", "--counterparty", "c", "--amount", "1", "--due", "2026-10-31", "--discount-percent", "2", "--yes"], /go together/],
    [["status", "--base-url", "http://example.com"], /https URL, or http to localhost/],
    [["status", "--base-url", "not a url"], /not a URL/],
    [["decisions", "show", "abc"], /<seq> is the entry's number/],
    [["login", "--api-key", KEY], /leave out --api-key/],
  ])("refuses %j as a usage error (exit 1), sending nothing", async (argv, message) => {
    const h = harness({ env: ENV_KEY });
    expect(await h.run(...argv)).toBe(1);
    expect(h.stderr).toMatch(message);
    expect(h.stdout).toBe("");
    expect(h.sent).toEqual([]);
  });
});

describe("the API key and the base URL", () => {
  const status = { "GET /api/v1/status": ok("get-status") };
  const bearer = (h: Harness) => h.sent[0].headers.authorization;

  it("takes --api-key over VESTIARION_API_KEY over the saved profile", async () => {
    const all = harness({ env: { VESTIARION_API_KEY: OTHER_KEY }, routes: status });
    saveProfiles(all, { default: { apiKey: THIRD_KEY } });
    expect(await all.run("status", "--api-key", KEY)).toBe(0);
    expect(bearer(all)).toBe(`Bearer ${KEY}`);

    const envOverProfile = harness({ env: { VESTIARION_API_KEY: OTHER_KEY }, routes: status });
    saveProfiles(envOverProfile, { default: { apiKey: THIRD_KEY } });
    expect(await envOverProfile.run("status")).toBe(0);
    expect(bearer(envOverProfile)).toBe(`Bearer ${OTHER_KEY}`);

    const profileOnly = harness({ routes: status });
    saveProfiles(profileOnly, { default: { apiKey: THIRD_KEY } });
    expect(await profileOnly.run("status")).toBe(0);
    expect(bearer(profileOnly)).toBe(`Bearer ${THIRD_KEY}`);
  });

  it("reads the profile --profile names, else VESTIARION_PROFILE's, else default", async () => {
    const profiles = { default: { apiKey: KEY }, staging: { apiKey: OTHER_KEY }, ops: { apiKey: THIRD_KEY } };
    const flag = harness({ env: { VESTIARION_PROFILE: "ops" }, routes: status });
    saveProfiles(flag, profiles);
    await flag.run("status", "--profile", "staging");
    expect(bearer(flag)).toBe(`Bearer ${OTHER_KEY}`);
    const env = harness({ env: { VESTIARION_PROFILE: "ops" }, routes: status });
    saveProfiles(env, profiles);
    await env.run("status");
    expect(bearer(env)).toBe(`Bearer ${THIRD_KEY}`);
  });

  it("sends a profile's key to the base URL saved with it, and a key from the flag or environment never there", async () => {
    const saved = harness({ routes: status });
    saveProfiles(saved, { default: { apiKey: KEY, baseUrl: "http://localhost:3000" } });
    await saved.run("status");
    expect(saved.sent[0].url).toBe("http://localhost:3000/api/v1/status");

    const fromEnv = harness({ env: { VESTIARION_API_KEY: OTHER_KEY }, routes: status });
    saveProfiles(fromEnv, { default: { apiKey: KEY, baseUrl: "http://localhost:3000" } });
    await fromEnv.run("status");
    expect(fromEnv.sent[0].url).toBe("https://www.vestiarion.xyz/api/v1/status");
  });

  it("takes --base-url over VESTIARION_BASE_URL over the default", async () => {
    const both = harness({ env: { ...ENV_KEY, VESTIARION_BASE_URL: "https://staging.example.com" }, routes: status });
    await both.run("status", "--base-url", "http://127.0.0.1:3000/");
    expect(both.sent[0].url).toBe("http://127.0.0.1:3000/api/v1/status");
    const env = harness({ env: { ...ENV_KEY, VESTIARION_BASE_URL: "https://staging.example.com" }, routes: status });
    await env.run("status");
    expect(env.sent[0].url).toBe("https://staging.example.com/api/v1/status");
    const neither = harness({ env: ENV_KEY, routes: status });
    await neither.run("status");
    expect(neither.sent[0].url).toBe("https://www.vestiarion.xyz/api/v1/status");
  });

  it("ends with an auth error (exit 3) when there is no key, naming a missing profile, and sends nothing", async () => {
    const none = harness();
    expect(await none.run("whoami")).toBe(3);
    expect(none.stderr).toMatch(/No API key\. Run `vestiarion login`/);
    const named = harness();
    expect(await named.run("bills", "list", "--profile", "staging")).toBe(3);
    expect(named.stderr).toContain('No key is saved for profile "staging"');
    expect([...none.sent, ...named.sent]).toEqual([]);
  });

  it("refuses a key that is not shaped like one (exit 3) before sending anything, without repeating it", async () => {
    const h = harness({ env: { VESTIARION_API_KEY: "sk_live_not-a-vestiarion-key" } });
    expect(await h.run("status")).toBe(3);
    expect(h.stderr).toContain("VESTIARION_API_KEY is not a Vestiarion API key");
    expect(h.stderr).not.toContain("sk_live");
    expect(h.sent).toEqual([]);
  });

  it("keeps its config file where each system keeps a user's: %APPDATA% on Windows, XDG_CONFIG_HOME or ~/.config elsewhere", () => {
    const home = path.resolve("home-dir");
    const appData = path.resolve("roaming");
    const xdg = path.resolve("xdg-dir");
    expect(configPath({ platform: "win32", homedir: home, env: { APPDATA: appData } })).toBe(path.join(appData, "vestiarion", "config.json"));
    expect(configPath({ platform: "win32", homedir: home, env: {} })).toBe(path.join(home, ".config", "vestiarion", "config.json"));
    expect(configPath({ platform: "linux", homedir: home, env: { XDG_CONFIG_HOME: xdg } })).toBe(path.join(xdg, "vestiarion", "config.json"));
    expect(configPath({ platform: "darwin", homedir: home, env: {} })).toBe(path.join(home, ".config", "vestiarion", "config.json"));
    expect(configPath({ platform: "linux", homedir: home, env: { XDG_CONFIG_HOME: "relative/dir" } })).toBe(path.join(home, ".config", "vestiarion", "config.json"));
  });
});

describe("login and logout", () => {
  const status = { "GET /api/v1/status": ok("get-status") };

  it("reads the key at a hidden prompt, checks it with one read, and saves it readable by the user alone", async () => {
    const h = harness({ tty: true, typed: `  ${KEY}  `, routes: status });
    expect(await h.run("login")).toBe(0);
    expect(h.prompts).toEqual(['API key for profile "default": ']);
    expect(h.sent.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(["GET /api/v1/status"]);
    const file = configPath(h.io);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.profiles.default).toMatchObject({ apiKey: KEY, workspace: "Vestiarion workspace" });
    expect(saved.profiles.default.baseUrl).toBeUndefined();
    expect(h.stdout).toContain("vxk_abcdefgh_…");
    expect(h.stdout).toContain('as profile "default"');
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("keeps the file private when it already existed with wider permissions", async () => {
    const h = harness({ stdin: KEY, routes: status });
    const file = saveProfiles(h, { other: { apiKey: OTHER_KEY } });
    if (process.platform !== "win32") (await import("node:fs")).chmodSync(file, 0o644);
    expect(await h.run("login", "--stdin", "--profile", "work", "--base-url", "http://localhost:3000")).toBe(0);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(saved.profiles).sort()).toEqual(["other", "work"]);
    expect(saved.profiles.work).toMatchObject({ apiKey: KEY, baseUrl: "http://localhost:3000" });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("saves nothing when the API refuses the key (exit 3), or the key is not shaped like one", async () => {
    const refused = harness({ stdin: KEY, routes: { "GET /api/v1/status": apiError(401, "unauthorized", "A valid API key is required.") } });
    expect(await refused.run("login", "--stdin")).toBe(3);
    expect(refused.stderr).toContain("A valid API key is required. (HTTP 401 unauthorized) Nothing was saved.");
    expect(existsSync(configPath(refused.io))).toBe(false);

    const malformed = harness({ stdin: "hello" });
    expect(await malformed.run("login", "--stdin")).toBe(3);
    expect(malformed.sent).toEqual([]);
    expect(existsSync(configPath(malformed.io))).toBe(false);
  });

  it("asks for --stdin when there is no terminal to type in (exit 1)", async () => {
    const h = harness({ tty: false });
    expect(await h.run("login")).toBe(1);
    expect(h.stderr).toContain("--stdin");
    expect(h.sent).toEqual([]);
  });

  it("removes one profile on logout, keeps the others, and says when there was nothing to remove", async () => {
    const h = harness();
    const file = saveProfiles(h, { default: { apiKey: KEY }, staging: { apiKey: OTHER_KEY } });
    expect(await h.run("logout", "--profile", "staging")).toBe(0);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).profiles)).toEqual(["default"]);
    expect(h.stdout).toContain("vxk_zyxwvuts_…");
    expect(h.stdout).toContain("still works until it is revoked");
    const again = harness();
    expect(await again.run("logout")).toBe(0);
    expect(again.stdout).toContain("nothing to remove");
  });
});

describe("the commands, against the API's recorded answers", () => {
  it("whoami: the workspace, its network from the operating account, and the key's prefix and source", async () => {
    const h = harness({ env: ENV_KEY, routes: { "GET /api/v1/status": ok("get-status"), "GET /api/v1/treasury": ok("get-treasury") } });
    expect(await h.run("whoami")).toBe(0);
    expect(h.stdout).toMatch(/Workspace\s+Vestiarion workspace/);
    expect(h.stdout).toMatch(/Network\s+Arc testnet \(ARC-TESTNET\)/);
    expect(h.stdout).toMatch(/Key\s+vxk_abcdefgh_… \(from VESTIARION_API_KEY\)/);
    const json = harness({ env: ENV_KEY, routes: { "GET /api/v1/status": ok("get-status"), "GET /api/v1/treasury": ok("get-treasury") } });
    expect(await json.run("whoami", "--json")).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      workspace: "Vestiarion workspace",
      network: { chain: "ARC-TESTNET", label: "Arc testnet" },
      key: { prefix: "vxk_abcdefgh_…", source: "env" },
      baseUrl: "https://www.vestiarion.xyz",
      payments: "live",
      lastCycleAt: "2026-09-24T18:33:04.546517+00:00",
    });
  });

  it("whoami names Arc mainnet from an ARC operating account", async () => {
    const treasury = recorded("get-treasury") as { data: { accounts: Array<{ kind: string; chain: string }> } };
    for (const account of treasury.data.accounts) if (account.kind === "operating") account.chain = "ARC";
    const h = harness({ env: ENV_KEY, routes: { "GET /api/v1/status": ok("get-status"), "GET /api/v1/treasury": { status: 200, body: treasury } } });
    await h.run("whoami");
    expect(h.stdout).toMatch(/Network\s+Arc mainnet \(ARC\)/);
  });

  it.each([
    [["status"], "GET /api/v1/status", "get-status", ["Vestiarion workspace", "live", "simulate, day 25", "77 logged, 1 flagged", "4.815 USDC"]],
    [["bills", "list"], "GET /api/v1/invoices", "list-invoices", ["9440f32c-000d-4a63-97f1-4eb6bf78439f", "paid", "0.11 USDC", "2026-09-28", "Vercel Inc", "--cursor eyJr"]],
    [["invoices", "list"], "GET /api/v1/invoices", "list-invoices", ["9440f32c-000d-4a63-97f1-4eb6bf78439f"]],
    [["counterparties", "list"], "GET /api/v1/counterparties", "list-counterparties", ["Anthropic API Services", "vendor", "clear", "5 USDC", "ARC-TESTNET"]],
    [["counterparties", "show", "dc5e5751-3287-46c9-8bd1-83a42ab02699"], "GET /api/v1/counterparties/dc5e5751-3287-46c9-8bd1-83a42ab02699", "get-counterparty", ["Anthropic API Services", "No match against watchlist", "simulated-sanctions-list"]],
    [["milestones", "list"], "GET /api/v1/milestones", "list-milestones", ["d01b2b49-2ca3-45fe-898c-f2c0128f6188", "paid", "0.9 USDC", "Diego Ramirez"]],
    [["ledger", "list"], "GET /api/v1/ledger", "list-ledger-entries", ["82", "system", "seed", "Seeded demo business: Northstar Studio"]],
    [["treasury"], "GET /api/v1/treasury", "get-treasury", ["Arc Operating Wallet", "22.765 USDC", "4.5%", "Liquidity healthy."]],
    [["insights"], "GET /api/v1/insights", "get-insights", ["Cycle runs", "Transfers", "Screenings"]],
  ])("%j reads %s and prints it as text, and as the API's own JSON with --json", async (argv, route, example, expected) => {
    const text = harness({ env: ENV_KEY, routes: { [route]: ok(example) } });
    expect(await text.run(...argv)).toBe(0);
    for (const fragment of expected) expect(text.stdout).toContain(fragment);
    expect(text.stderr).toBe("");
    const json = harness({ env: ENV_KEY, routes: { [route]: ok(example) } });
    expect(await json.run(...argv, "--json")).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(recorded(example));
    expect(json.sent).toHaveLength(1);
    expect(`${json.sent[0].method} ${new URL(json.sent[0].url).pathname}`).toBe(route);
  });

  it("filters bills to payables and invoices to receivables, passing the other filters through", async () => {
    const bills = harness({ env: ENV_KEY, routes: { "GET /api/v1/invoices": ok("list-invoices") } });
    await bills.run("bills", "list", "--status", "held", "--counterparty", "c-1", "--limit", "20", "--cursor", "abc");
    expect(query(bills)).toEqual({ direction: "payable", status: "held", counterpartyId: "c-1", limit: "20", cursor: "abc" });
    const invoices = harness({ env: ENV_KEY, routes: { "GET /api/v1/invoices": ok("list-invoices") } });
    await invoices.run("invoices", "list");
    expect(query(invoices)).toEqual({ direction: "receivable" });
    const others = harness({ env: ENV_KEY, routes: { "GET /api/v1/counterparties": ok("list-counterparties"), "GET /api/v1/milestones": ok("list-milestones"), "GET /api/v1/ledger": ok("list-ledger-entries") } });
    await others.run("counterparties", "list", "--role", "vendor", "--risk", "high");
    await others.run("milestones", "list", "--status", "pending", "--contractor", "k-1");
    await others.run("ledger", "list", "--domain", "ap", "--actor", "human");
    expect([query(others, 0), query(others, 1), query(others, 2)]).toEqual([
      { role: "vendor", riskLevel: "high" },
      { status: "pending", contractorId: "k-1" },
      { domain: "ap", actor: "human" },
    ]);
  });

  it("reads every page with --all, following each cursor, and answers one page in the API's shape", async () => {
    const first = recorded("list-invoices") as { data: Array<{ id: string }>; page: { nextCursor: string } };
    const second = { data: [{ ...first.data[0], id: "00000000-0000-4000-8000-000000000002" }], page: { nextCursor: null, hasMore: false, count: 1 } };
    const h = harness({
      env: ENV_KEY,
      routes: { "GET /api/v1/invoices": (url) => ({ status: 200, body: url.searchParams.get("cursor") === first.page.nextCursor ? second : first }) },
    });
    expect(await h.run("bills", "list", "--all", "--json")).toBe(0);
    const answer = JSON.parse(h.stdout);
    expect(answer.data.map((invoice: { id: string }) => invoice.id)).toEqual([first.data[0].id, second.data[0].id]);
    expect(answer.page).toEqual({ nextCursor: null, hasMore: false, count: 2 });
    expect(h.sent.map((request) => query({ sent: [request] } as Harness).cursor)).toEqual([undefined, first.page.nextCursor]);
  });

  it("shows a bill by reading its list page by page, with the agent's reasoning, and says when there is none (exit 2)", async () => {
    const first = recorded("list-invoices") as { data: Array<{ id: string }>; page: { nextCursor: string } };
    const wanted = { ...first.data[0], id: "00000000-0000-4000-8000-00000000000b", agentReasoning: "Held: the purchase order is missing." };
    const routes = {
      "GET /api/v1/invoices": (url: URL) => ({
        status: 200,
        body: url.searchParams.get("cursor") ? { data: [wanted], page: { nextCursor: null, hasMore: false, count: 1 } } : first,
      }),
    };
    const h = harness({ env: ENV_KEY, routes });
    expect(await h.run("bills", "show", wanted.id)).toBe(0);
    expect(h.stdout).toContain(wanted.id);
    expect(h.stdout).toContain("Held: the purchase order is missing.");
    expect(query(h, 0)).toEqual({ direction: "payable", limit: "200" });
    const missing = harness({ env: ENV_KEY, routes });
    expect(await missing.run("bills", "show", "no-such-id")).toBe(2);
    expect(missing.stderr).toContain("No bill with id no-such-id");
    expect(missing.stdout).toBe("");
  });

  it("shows a milestone the same way", async () => {
    const h = harness({ env: ENV_KEY, routes: { "GET /api/v1/milestones": ok("list-milestones") } });
    expect(await h.run("milestones", "show", "d01b2b49-2ca3-45fe-898c-f2c0128f6188")).toBe(0);
    expect(h.stdout).toContain("immediate release is justified");
  });

  describe("decisions", () => {
    const entry = (recorded("list-ledger-entries") as { data: Array<Record<string, unknown>> }).data[0];
    const decision = {
      ...entry,
      seq: 120,
      actor: "agent",
      domain: "ap",
      action: "ap_hold",
      summary: "HOLD invoice from Zenith Trading LLC for 1.2 USDC",
      detail: { invoiceId: "i-1", decision: { action: "hold", reasoning: "The amount is above the counterparty's payment limit of 1 USDC." } },
    };
    const page = { data: [decision], page: { nextCursor: null, hasMore: false, count: 1 } };

    it("lists the agent's ledger entries with the reasoning each records", async () => {
      const h = harness({ env: ENV_KEY, routes: { "GET /api/v1/ledger": { status: 200, body: page } } });
      expect(await h.run("decisions", "list", "--domain", "ap")).toBe(0);
      expect(query(h)).toEqual({ actor: "agent", domain: "ap" });
      expect(h.stdout).toContain("#120");
      expect(h.stdout).toContain("HOLD invoice from Zenith Trading LLC");
      expect(h.stdout).toContain("Why: The amount is above the counterparty's payment limit");
    });

    it("shows one decision by its number, and says when the agent wrote none (exit 2)", async () => {
      const h = harness({ env: ENV_KEY, routes: { "GET /api/v1/ledger": { status: 200, body: page } } });
      expect(await h.run("decisions", "show", "#120")).toBe(0);
      expect(h.stdout).toContain("ap ap_hold");
      expect(h.stdout).toContain('"invoiceId": "i-1"');
      const json = harness({ env: ENV_KEY, routes: { "GET /api/v1/ledger": { status: 200, body: page } } });
      await json.run("decisions", "show", "120", "--json");
      expect(JSON.parse(json.stdout)).toEqual({ data: decision });
      const missing = harness({ env: ENV_KEY, routes: { "GET /api/v1/ledger": { status: 200, body: page } } });
      expect(await missing.run("decisions", "show", "7")).toBe(2);
    });
  });

  it.each([
    [{ valid: true, checkedEntries: 99 }, 0, "VALID: 99 entries checked"],
    [{ valid: false, checkedEntries: 12, brokenAt: 7, reason: "signature mismatch" }, 2, "BROKEN at entry #7: signature mismatch"],
    [{ valid: null, checkedEntries: 0, reason: "No public key is configured." }, 2, "NOT CHECKED: No public key is configured."],
  ])("ledger check prints the API's verdict on %j and exits %i", async (verdict, code, line) => {
    const h = harness({ env: ENV_KEY, routes: { "GET /api/v1/ledger/verify": { status: 200, body: { data: verdict } } } });
    expect(await h.run("ledger", "check")).toBe(code);
    expect(h.stdout).toContain(line);
  });
});

describe("writes", () => {
  const created = (name: string) => ({ status: 201, body: recorded(name) });
  const BILL = ["bills", "add", "--counterparty", "6b361405-cfda-4400-a286-364b561911ce", "--amount", "420.00", "--due", "2026-10-31", "--po", "PO-4012", "--goods-received"];

  it("sends a bill with --yes, with its Idempotency-Key, and prints what the API added", async () => {
    const h = harness({ env: ENV_KEY, routes: { "POST /api/v1/invoices": created("create-invoice") } });
    expect(await h.run(...BILL, "--idempotency-key", "billing-inv-42", "--yes")).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(JSON.parse(h.sent[0].body!)).toEqual({
      direction: "payable",
      counterpartyId: "6b361405-cfda-4400-a286-364b561911ce",
      amount: "420.00",
      dueDate: "2026-10-31",
      poReference: "PO-4012",
      goodsReceived: true,
    });
    expect(h.sent[0].headers["idempotency-key"]).toBe("billing-inv-42");
    expect(h.sent[0].headers["content-type"]).toBe("application/json");
    expect(h.stdout).toContain("Added bill 1f96fd0b-71de-41bf-b088-779655ea6df4");
    expect(h.stdout).toContain("vestiarion bills show 1f96fd0b-71de-41bf-b088-779655ea6df4");
    expect(h.prompts).toEqual([]);
    const json = harness({ env: ENV_KEY, routes: { "POST /api/v1/invoices": created("create-invoice") } });
    await json.run(...BILL, "--yes", "--json");
    expect(JSON.parse(json.stdout)).toEqual(recorded("create-invoice"));
  });

  it("refuses to send without a terminal and without --yes (exit 2), after showing what it would have sent", async () => {
    const h = harness({ env: ENV_KEY, tty: false, routes: { "POST /api/v1/invoices": created("create-invoice") } });
    expect(await h.run(...BILL)).toBe(2);
    expect(h.sent).toEqual([]);
    expect(h.stdout).toBe("");
    expect(h.stderr).toContain("POST https://www.vestiarion.xyz/api/v1/invoices");
    expect(h.stderr).toContain('"amount": "420.00"');
    expect(h.stderr).toContain("may pay it");
    expect(h.stderr).toContain("Nothing was sent: there is no terminal to confirm in. Pass --yes");
  });

  it("asks in a terminal, sends on yes, and sends nothing on no (exit 2)", async () => {
    const no = harness({ env: ENV_KEY, tty: true, answer: false, routes: { "POST /api/v1/invoices": created("create-invoice") } });
    expect(await no.run(...BILL)).toBe(2);
    expect(no.prompts).toEqual(["Send it? [y/N] "]);
    expect(no.sent).toEqual([]);
    expect(no.stderr).toContain("Nothing was sent.");
    const yes = harness({ env: ENV_KEY, tty: true, answer: true, routes: { "POST /api/v1/invoices": created("create-invoice") } });
    expect(await yes.run(...BILL)).toBe(0);
    expect(yes.sent).toHaveLength(1);
    expect(yes.sent[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each([
    [
      ["invoices", "create", "--counterparty", "c-9", "--amount", "1250.50", "--due", "2026-11-15", "--memo", "October retainer", "--currency", "EURC"],
      "POST /api/v1/invoices",
      "create-invoice",
      { direction: "receivable", counterpartyId: "c-9", amount: "1250.50", dueDate: "2026-11-15", memo: "October retainer", currency: "EURC" },
    ],
    [
      ["counterparties", "add", "--name", "Quill Studio", "--role", "vendor", "--address", "0x5b2d8c1f0e7a4936b8d1c0e2f3a4b5c6d7e8f901", "--payment-limit", "500", "--chain", "ARC"],
      "POST /api/v1/counterparties",
      "create-counterparty",
      { name: "Quill Studio", role: "vendor", address: "0x5b2d8c1f0e7a4936b8d1c0e2f3a4b5c6d7e8f901", paymentLimit: "500", chain: "ARC" },
    ],
    [
      ["milestones", "add", "--contractor", "k-1", "--title", "CSV export for EURC", "--amount", "150.00", "--verification-source", "https://github.com/acme/app/pull/42"],
      "POST /api/v1/milestones",
      "create-milestone",
      { contractorId: "k-1", title: "CSV export for EURC", amount: "150.00", verificationSource: "https://github.com/acme/app/pull/42" },
    ],
    [["payee-links", "create", "--counterparty", "k-1"], "POST /api/v1/payee-links", "create-payee-link", { counterpartyId: "k-1" }],
  ])("%j sends exactly its fields with --yes", async (argv, route, example, body) => {
    const h = harness({ env: ENV_KEY, routes: { [route]: created(example) } });
    expect(await h.run(...argv, "--yes")).toBe(0);
    expect(`${h.sent[0].method} ${new URL(h.sent[0].url).pathname}`).toBe(route);
    expect(JSON.parse(h.sent[0].body!)).toEqual(body);
    const json = harness({ env: ENV_KEY, routes: { [route]: created(example) } });
    await json.run(...argv, "--yes", "--json");
    expect(JSON.parse(json.stdout)).toEqual(recorded(example));
  });

  it("sends a payee link with no Idempotency-Key, and prints the link once", async () => {
    const h = harness({ env: ENV_KEY, routes: { "POST /api/v1/payee-links": created("create-payee-link") } });
    await h.run("payee-links", "create", "--counterparty", "k-1", "--yes");
    expect(h.sent[0].headers["idempotency-key"]).toBeUndefined();
    expect(h.stdout).toContain("https://www.vestiarion.xyz/payee/vxp_");
  });

  it.each([
    [apiError(400, "invalid_request", "dueDate must be a day, YYYY-MM-DD."), 2, "Error: dueDate must be a day, YYYY-MM-DD. (HTTP 400 invalid_request)"],
    [apiError(403, "forbidden", "This key cannot do that."), 3, "Error: This key cannot do that. (HTTP 403 forbidden)"],
    [apiError(401, "unauthorized", "A valid API key is required."), 3, "Error: A valid API key is required. (HTTP 401 unauthorized)"],
    [apiError(409, "conflict", "This Idempotency-Key was used with a different body."), 2, "(HTTP 409 conflict)"],
    [apiError(429, "rate_limited", "Too many writes from this key. Try again in a minute.", { "Retry-After": "60" }), 2, "(HTTP 429 rate_limited) Retry after 60 s."],
    [apiError(500, "internal", "The request could not be completed."), 2, "(HTTP 500 internal)"],
    [{ status: 502, body: "<html>Bad gateway</html>" }, 2, "The API answered HTTP 502."],
  ])("shows the API's refusal as it is and exits %#", async (answer, code, message) => {
    const h = harness({ env: ENV_KEY, routes: { "POST /api/v1/invoices": answer } });
    expect(await h.run(...BILL, "--yes")).toBe(code);
    expect(h.stderr).toContain(message);
    expect(h.stdout).toBe("");
  });

  it("reports a network failure (exit 2) and never claims success", async () => {
    const h = harness({
      env: ENV_KEY,
      routes: {
        "POST /api/v1/invoices": () => {
          throw new Error("ECONNRESET");
        },
      },
    });
    expect(await h.run(...BILL, "--yes")).toBe(2);
    expect(h.stderr).toContain("The request did not reach the API. (network_error)");
    expect(h.stdout).toBe("");
  });

  it("writes errors as JSON on stderr with --json", async () => {
    const h = harness({ env: ENV_KEY, routes: { "POST /api/v1/invoices": apiError(400, "invalid_request", "amount must be positive.") } });
    expect(await h.run(...BILL, "--yes", "--json")).toBe(2);
    expect(JSON.parse(h.stderr)).toEqual({ error: { message: "amount must be positive. (HTTP 400 invalid_request)", exitCode: 2 } });
    expect(h.stdout).toBe("");
  });
});

describe("the key", () => {
  it("is never printed, never in a URL, and always a bearer header, whatever the command and however it ends", async () => {
    const routes = {
      "GET /api/v1/status": ok("get-status"),
      "GET /api/v1/treasury": ok("get-treasury"),
      "GET /api/v1/invoices": ok("list-invoices"),
      "POST /api/v1/invoices": apiError(400, "invalid_request", "dueDate must be a day."),
      "GET /api/v1/counterparties": apiError(500, "internal", "The request could not be completed."),
    };
    const runs: Array<{ argv: string[]; tty?: boolean; env?: Record<string, string>; stdin?: string; typed?: string }> = [
      { argv: ["whoami"] },
      { argv: ["whoami", "--json"] },
      { argv: ["status", "--json"] },
      { argv: ["bills", "list"] },
      { argv: ["counterparties", "list"] },
      { argv: ["bills", "add", "--counterparty", "c", "--amount", "1", "--due", "2026-10-31"] },
      { argv: ["bills", "add", "--counterparty", "c", "--amount", "1", "--due", "2026-10-31"], tty: true },
      { argv: ["bills", "add", "--counterparty", "c", "--amount", "1", "--due", "2026-10-31", "--yes", "--json"] },
      { argv: ["status", "--api-key", KEY] },
      { argv: ["login", "--stdin"], env: {}, stdin: KEY },
      { argv: ["login"], env: {}, tty: true, typed: KEY },
      { argv: ["login", "--stdin", "--json"], env: {}, stdin: KEY },
    ];
    for (const { argv, tty, env, stdin, typed } of runs) {
      const h = harness({ env: env ?? ENV_KEY, tty, stdin, typed, routes, answer: true });
      await h.run(...argv);
      if (argv[0] === "login") await h.run("whoami");
      if (argv[0] === "login") await h.run("logout");
      for (const output of [h.stdout, h.stderr]) {
        expect(output, argv.join(" ")).not.toContain(SECRET);
        expect(output, argv.join(" ")).not.toContain(SECRET.slice(0, 12));
      }
      for (const request of h.sent) {
        expect(request.url).not.toContain(SECRET);
        expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(request.headers["user-agent"]).toMatch(/^vestiarion-cli\/\d+\.\d+\.\d+ vestiarion-sdk-js\/\d+\.\d+\.\d+$/);
      }
    }
  });
});
