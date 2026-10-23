import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { TENANT_RPCS, TENANT_TABLES } from "@/lib/dal";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";
import { signedOrgs } from "./support/signed-org";

vi.mock("server-only", () => ({}));

import { readPortfolio } from "@/lib/accountant/read";

/**
 * The accountant console's read model (docs/superpowers/specs/2026-10-13-accountant-console-design.md A2): an accountant
 * invited to three of four workspaces sees exactly those three, each read through its own tenant token naming it and
 * the accountant, never the service role, and never the fourth. Removing the membership takes the workspace off the
 * next read.
 */

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();

const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a2";
const WORKSPACES = [
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01", slug: "harbor-bakery", name: "Harbor Bakery" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c02", slug: "lumen-studio", name: "Lumen Studio" },
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c03", slug: "pine-dental", name: "Pine Dental" },
  // The fourth: the accountant was never invited here.
  { id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c04", slug: "north-garage", name: "North Garage" },
] as const;
const NOW = new Date("2026-10-13T09:00:00.000Z");

type Membership = { user: string; org: (typeof WORKSPACES)[number]; role: string };

function claimsOf(request: RecordedRequest): Record<string, unknown> | null {
  const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const parts = bearer.split(".");
  if (parts.length !== 3) return null;
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

function world(memberships: Membership[], extra: (sent: RecordedRequest) => FakeReply | null = () => null) {
  const fake = fakeSupabase((sent): FakeReply => {
    const answered = extra(sent);
    if (answered) return answered;
    if (sent.path === "/rest/v1/memberships") {
      // As PostgREST filters it: by the user the request names, and by slug when one is named.
      const user = sent.params.get("user_id")?.replace(/^eq\./, "");
      const slug = sent.params.get("orgs.slug")?.replace(/^eq\./, "");
      return {
        body: memberships
          .filter((row) => row.user === user && (!slug || row.org.slug === slug))
          .map((row) => ({ role: row.role, orgs: { id: row.org.id, slug: row.org.slug, name: row.org.name, mode: "live", network: "arc-testnet", last_active_at: null } })),
      };
    }
    if (sent.path === "/rest/v1/orgs") {
      const id = sent.params.get("id")?.replace(/^eq\./, "");
      const org = WORKSPACES.find((candidate) => candidate.id === id);
      return org ? { body: orgs.orgRow(org.id, { slug: org.slug, name: org.name, mode: "live", network: "arc-testnet" }) } : { status: 406, body: { code: "PGRST116", message: "no rows" } };
    }
    if (sent.method === "HEAD") return { body: [], headers: { "content-range": "*/0" } };
    // Every workspace, the fourth too, has a payable held for a person: only a read in its scope finds it.
    if (sent.path === "/rest/v1/invoices" && sent.params.get("direction") === "eq.payable") {
      const orgId = String(claimsOf(sent)?.org_id ?? "");
      const org = WORKSPACES.find((candidate) => candidate.id === orgId);
      if (!org) return { body: [] };
      return {
        body: [
          {
            id: `${org.slug}-bill`,
            amount: "1250",
            currency: "USDC",
            due_date: "2026-10-20",
            status: "held",
            decided_at: "2026-10-10T08:00:00Z",
            created_at: "2026-10-09T08:00:00Z",
            early_pay_discount_pct: null,
            discount_due_date: null,
            counterparties: { name: `${org.name} supplier` },
          },
        ],
      };
    }
    return { body: [] };
  });
  const read = () => runWith({ config, db: fake.client, fetch: fake.fetch }, () => readPortfolio(ACCOUNTANT, NOW));
  return { fake, read };
}

const INVITED: Membership[] = [
  { user: ACCOUNTANT, org: WORKSPACES[0], role: "accountant" },
  { user: ACCOUNTANT, org: WORKSPACES[1], role: "accountant" },
  { user: ACCOUNTANT, org: WORKSPACES[2], role: "accountant" },
  ...WORKSPACES.map((org) => ({ user: OWNER, org, role: "owner" })),
];

describe("readPortfolio", () => {
  it("lists exactly the three workspaces the accountant was invited to, and not the fourth", async () => {
    const { read } = world(INVITED);
    const portfolio = await read();
    expect(portfolio.workspaces.map((workspace) => workspace.slug).sort()).toEqual(["harbor-bakery", "lumen-studio", "pine-dental"]);
    expect(portfolio.items.map((item) => item.workspace.slug).sort()).toEqual(["harbor-bakery", "lumen-studio", "pine-dental"]);
    expect(portfolio.items.some((item) => item.title.startsWith("North Garage"))).toBe(false);
    expect(portfolio.workspaces.every((workspace) => workspace.role === "accountant")).toBe(true);
  });

  it("reads the list of workspaces by the accountant's own user id, and nothing else", async () => {
    const { fake, read } = world(INVITED);
    await read();
    const lists = fake.requests.filter((sent) => sent.path === "/rest/v1/memberships");
    expect(lists).toHaveLength(1);
    expect(lists[0].params.get("user_id")).toBe(`eq.${ACCOUNTANT}`);
  });

  it("reads every workspace's data through a tenant token naming that workspace and the accountant, never the service role or the fourth", async () => {
    const { fake, read } = world(INVITED);
    await read();
    const tenantReads = fake.requests.filter((sent) => (TENANT_TABLES as readonly string[]).includes(sent.path.replace("/rest/v1/", "")));
    expect(tenantReads.length).toBeGreaterThan(0);
    const invited = new Set<string>(WORKSPACES.slice(0, 3).map((org) => org.id));
    for (const sent of tenantReads) {
      const claims = claimsOf(sent);
      expect(claims, sent.path).not.toBeNull();
      expect(claims?.role).toBe("vestiarion_tenant");
      expect(claims?.sub).toBe(ACCOUNTANT);
      expect(invited.has(String(claims?.org_id)), `${sent.path} read ${String(claims?.org_id)}`).toBe(true);
      // The DAL's own filter names the same workspace as the token.
      if (sent.method === "GET") expect(sent.params.get("org_id")).toBe(`eq.${String(claims?.org_id)}`);
    }
    expect(new Set(tenantReads.map((sent) => String(claimsOf(sent)?.org_id)))).toEqual(invited);
  });

  it("drops a workspace on the next read once the accountant is removed from it", async () => {
    const before = await world(INVITED).read();
    expect(before.workspaces).toHaveLength(3);
    const removed = INVITED.filter((row) => !(row.user === ACCOUNTANT && row.org.slug === "lumen-studio"));
    const { fake, read } = world(removed);
    const after = await read();
    expect(after.workspaces.map((workspace) => workspace.slug).sort()).toEqual(["harbor-bakery", "pine-dental"]);
    const lumen = WORKSPACES[1].id;
    expect(fake.requests.some((sent) => claimsOf(sent)?.org_id === lumen)).toBe(false);
  });

  it("routes each item: a held payment waits on an approver when the viewer is the accountant", async () => {
    const { read } = world(INVITED);
    const [item] = (await read()).items;
    expect(item).toMatchObject({
      kind: "decision",
      canAct: false,
      who: "Waiting on an owner, admin or approver of this workspace",
      amount: { value: 1250, currency: "USDC" },
      href: "/o/harbor-bakery/approvals#payable-harbor-bakery-bill",
    });
  });

  it("says an accountant books only on a Xero connection agreed under the words that name the accountant, as the booking command allows", async () => {
    // Harbor Bakery connected Xero before Oct 13 (only an owner or admin approves); Pine Dental since (an accountant may).
    const CONNECTIONS: Record<string, { id: string; consent: string }> = {
      [WORKSPACES[0].id]: { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000c0a01", consent: "xero-2026-10-12.2" },
      [WORKSPACES[2].id]: { id: "0b6c1c9e-4a4f-4a7e-9b1e-0000000c0a03", consent: "xero-2026-10-13" },
    };
    const { read } = world(INVITED, (sent) => {
      const connection = CONNECTIONS[String(claimsOf(sent)?.org_id ?? "")];
      if (sent.path === "/rest/v1/accounting_postings") {
        return {
          body: connection
            ? [{ id: `${connection.id}-posting`, connection_id: connection.id, provider: "xero", amount: "1250", currency: "USD", state: "draft", paid_on: "2026-10-10", message: null, created_at: "2026-10-11T08:00:00Z" }]
            : [],
        };
      }
      if (sent.path === "/rest/v1/accounting_connections" && sent.params.get("id")) {
        return { body: connection ? [{ id: connection.id, consent_version: connection.consent }] : [] };
      }
      return null;
    });
    const toBook = (await read()).items.filter((item) => item.kind === "to_book");
    expect(toBook.map((item) => [item.workspace.slug, item.canAct, item.who])).toEqual([
      ["pine-dental", true, "You can review and book it"],
      ["harbor-bakery", false, "Waiting on an owner or admin of this workspace: Xero was connected before an accountant could book"],
    ]);
  });

  it("lists no address to confirm to an accountant while co-signing is off", async () => {
    const { fake, read } = world(INVITED);
    const portfolio = await read();
    expect(portfolio.items.some((item) => item.kind === "confirm_address" || item.kind === "cosign")).toBe(false);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/counterparties" && sent.params.get("address_changed_at"))).toBe(false);
  });

  it("keeps listing a workspace whose data cannot be read, and says so, without hiding the others", async () => {
    const broken = fakeSupabase((sent): FakeReply => {
      if (sent.path === "/rest/v1/memberships") return { body: [{ role: "accountant", orgs: { id: WORKSPACES[0].id, slug: WORKSPACES[0].slug, name: WORKSPACES[0].name, mode: "live", network: "arc-testnet" } }] };
      if (sent.path === "/rest/v1/orgs") return { status: 500, body: { message: "down" } };
      return { body: [] };
    });
    const portfolio = await runWith({ config, db: broken.client, fetch: broken.fetch }, () => readPortfolio(ACCOUNTANT, NOW));
    expect(portfolio.workspaces).toEqual([expect.objectContaining({ slug: "harbor-bakery", items: [], unread: ["this workspace"] })]);
  });
});

/**
 * Bills waiting for the accountant's co-sign and addresses to confirm (docs/superpowers/specs/2026-10-22-accountant-queue-design.md
 * AQ3, AQ4): Harbor Bakery lets its accountants co-sign above 500 USDC; Lumen Studio and Pine Dental do not.
 */
describe("readPortfolio: what waits for the accountant", () => {
  const HARBOR = WORKSPACES[0];
  const ADDRESS = "0xabc0000000000000000000000000000000000001";
  const payable = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    amount: "1250",
    currency: "USDC",
    due_date: "2026-10-20",
    status: "held",
    decided_at: "2026-10-10T08:00:00Z",
    created_at: "2026-10-09T08:00:00Z",
    early_pay_discount_pct: null,
    discount_due_date: null,
    counterparty_id: `cp-${id}`,
    counterparties: { name: `Payee ${id}`, risk_level: "low", address: ADDRESS },
    ...over,
  });

  type Options = {
    cosignOn?: boolean;
    /** The payee lock (docs/superpowers/specs/2026-10-20-payee-lock-design.md); off unless set. */
    lock?: boolean;
    payables?: unknown[];
    counterparties?: unknown[];
    frozen?: string[];
    failing?: string;
  };

  /** Harbor's answers; the other workspaces answer as before, with co-signing off. */
  const harbor =
    (options: Options = {}) =>
    (sent: RecordedRequest): FakeReply | null => {
      const inHarbor = claimsOf(sent)?.org_id === HARBOR.id;
      if (options.failing && sent.path === options.failing && inHarbor) return { status: 500, body: { message: "down" } };
      if (sent.path === "/rest/v1/approval_policies") {
        return { body: inHarbor ? [{ two_approvals_above: "500", accountant_cosigns: options.cosignOn ?? true, payee_lock: options.lock ?? false, payee_lock_cooling_hours: 0 }] : [] };
      }
      if (!inHarbor) return null;
      if (sent.path === "/rest/v1/invoices" && sent.params.get("direction") === "eq.payable") return { body: options.payables ?? [payable("big"), payable("small", { amount: "200" })] };
      if (sent.path === "/rest/v1/counterparties" && sent.params.get("frozen_at")) return { body: (options.frozen ?? []).map((id) => ({ id })) };
      if (sent.path === "/rest/v1/counterparties" && sent.params.get("address_changed_at")) return { body: options.counterparties ?? [] };
      if (sent.path === "/rest/v1/rpc/approvers_among") return { body: (sent.body as { p_users: string[] }).p_users };
      if (sent.path === "/rest/v1/rpc/approvers_besides") return { body: 1 };
      if (sent.path === "/rest/v1/rpc/cosigners_besides") return { body: 1 };
      return null;
    };

  const harborItems = <T extends { workspace: { slug: string } }>(items: T[]): T[] => items.filter((item) => item.workspace.slug === HARBOR.slug);

  it("makes a bill the accountant can co-sign theirs to act on, in place of its decision item, and leaves the one below the figure", async () => {
    const { read } = world(INVITED, harbor());
    const portfolio = await read();
    const items = harborItems(portfolio.items);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      key: "harbor-bakery:cosign:big",
      kind: "cosign",
      canAct: true,
      who: "You can co-sign it",
      detail: "Payments above 500 USDC need two approvals. No one has approved it yet. Decide by Oct 20, 2026.",
      amount: { value: 1250, currency: "USDC" },
      since: "2026-10-10T08:00:00Z",
      href: "/o/harbor-bakery/approvals#payable-big",
    });
    expect(items[1]).toMatchObject({ kind: "decision", title: "Payee small", canAct: false, detail: "Held for a person. Decide by Oct 20, 2026." });
    // One item per bill: counted once on the card, and once among what the accountant can act on.
    const card = portfolio.workspaces.find((workspace) => workspace.slug === HARBOR.slug)!;
    expect(card.items.map((item) => item.kind)).toEqual(["cosign", "decision"]);
    expect(card.unread).toEqual([]);
    expect(portfolio.items.filter((item) => item.canAct)).toHaveLength(1);
    // The workspaces that do not co-sign keep their decision items.
    expect(portfolio.items.find((item) => item.workspace.slug === "lumen-studio")).toMatchObject({ kind: "decision", canAct: false });
  });

  it("reads the co-sign facts through the workspace's own tenant token, naming the accountant, never the service role", async () => {
    const { fake, read } = world(INVITED, harbor());
    await read();
    const harborReads = fake.requests.filter((sent) => sent.path !== "/rest/v1/memberships" && sent.path !== "/rest/v1/orgs" && claimsOf(sent)?.org_id === HARBOR.id);
    expect(harborReads.map((sent) => sent.path)).toEqual(expect.arrayContaining(["/rest/v1/approval_policies", "/rest/v1/payment_intents", "/rest/v1/payment_approvals", "/rest/v1/rpc/approvers_besides"]));
    const tenant = (request: RecordedRequest) =>
      request.path.startsWith("/rest/v1/rpc/")
        ? (TENANT_RPCS as readonly string[]).includes(request.path.replace("/rest/v1/rpc/", ""))
        : (TENANT_TABLES as readonly string[]).includes(request.path.replace("/rest/v1/", ""));
    // Every co-sign fact is a tenant table or function: nothing here reads as the platform.
    expect(harborReads.every(tenant)).toBe(true);
    for (const sent of fake.requests.filter(tenant)) {
      const claims = claimsOf(sent);
      expect(claims?.role, sent.path).toBe("vestiarion_tenant");
      expect(claims?.sub, sent.path).toBe(ACCOUNTANT);
      if (sent.method === "GET") expect(sent.params.get("org_id"), sent.path).toBe(`eq.${String(claims?.org_id)}`);
      if (sent.path.startsWith("/rest/v1/rpc/")) expect((sent.body as { p_org_id?: string }).p_org_id, sent.path).toBe(claims?.org_id);
    }
  });

  it("still ages a co-sign from the decide-by day it passed, and says when the accountant already co-signed one", async () => {
    const { read } = world(
      INVITED,
      (sent) =>
        (sent.path === "/rest/v1/payment_approvals" && claimsOf(sent)?.org_id === HARBOR.id
          ? { body: [{ source_id: "mine", id: "a1", approved_by: ACCOUNTANT, approved_at: "2026-10-12T08:00:00Z", amount: "1250", currency: "USDC", address: ADDRESS }] }
          : null) ?? harbor({ payables: [payable("late", { due_date: "2026-10-10" }), payable("mine")] })(sent)
    );
    const items = harborItems((await read()).items);
    expect(items.find((item) => item.key.endsWith(":late"))).toMatchObject({ kind: "cosign", since: "2026-10-10", detail: "Payments above 500 USDC need two approvals. No one has approved it yet. Its decide-by day was Oct 10, 2026." });
    expect(items.find((item) => item.key.endsWith(":mine"))).toMatchObject({
      kind: "decision",
      canAct: false,
      detail: "You co-signed it. An owner, admin or approver pays it. Held for a person. Decide by Oct 20, 2026.",
    });
  });

  it("gives a bill past its due date the day before its late fee starts, and says so (late fees LF5)", async () => {
    const late = payable("small", { amount: "200", due_date: "2026-10-10", late_fee_kind: "percent_month", late_fee_value: "1.5", late_fee_starts_on: "2026-10-20" });
    const { read } = world(INVITED, harbor({ payables: [late] }));
    expect(harborItems((await read()).items)).toEqual([
      expect.objectContaining({
        kind: "decision",
        detail: "Held for a person. Decide by Oct 19, 2026: overdue since Oct 10, 2026; a late fee of 1.5% a month starts Oct 20, 2026.",
      }),
    ]);
  });

  it("keeps the day before a late fee started as a bill's decide-by day once it has passed, and names the fee (late fees LF5)", async () => {
    const started = payable("small", { amount: "200", due_date: "2026-10-05", late_fee_kind: "percent_month", late_fee_value: "1.5", late_fee_starts_on: "2026-10-10" });
    const { read } = world(INVITED, harbor({ payables: [started] }));
    expect(harborItems((await read()).items)).toEqual([
      expect.objectContaining({
        kind: "past_decide_by",
        since: "2026-10-09",
        detail: "Held for a person. Its decide-by day was Oct 9, 2026, the day before its late fee of 1.5% a month started.",
      }),
    ]);
  });

  it("reads the bills again without their late fees before migration 0141, as before (late fees LF5)", async () => {
    const refused = vi.fn();
    const before0141 = (sent: RecordedRequest): FakeReply | null => {
      if (sent.path !== "/rest/v1/invoices" || !(sent.params.get("select") ?? "").includes("late_fee_")) return null;
      refused();
      return { status: 400, body: { code: "42703", message: "column invoices.late_fee_kind does not exist" } };
    };
    const { read } = world(INVITED, (sent) => before0141(sent) ?? harbor({ payables: [payable("small", { amount: "200" })] })(sent));
    const portfolio = await read();
    expect(refused).toHaveBeenCalled();
    expect(harborItems(portfolio.items)).toEqual([expect.objectContaining({ kind: "decision", detail: "Held for a person. Decide by Oct 20, 2026." })]);
  });

  it("leaves a bill the server would refuse as a decision item that says why", async () => {
    const { read } = world(INVITED, harbor({ payables: [payable("risky", { counterparties: { name: "Payee risky", risk_level: "high", address: ADDRESS } })] }));
    expect(harborItems((await read()).items)).toEqual([
      expect.objectContaining({ kind: "decision", canAct: false, detail: "Screened high risk. Held for a person. Decide by Oct 20, 2026." }),
    ]);
  });

  it("keeps today's items for another role, and while co-signing is off, without reading a co-sign fact", async () => {
    const asApprover = world(
      INVITED.map((row) => (row.user === ACCOUNTANT && row.org.slug === HARBOR.slug ? { ...row, role: "approver" } : row)),
      harbor()
    );
    const approverItems = harborItems((await asApprover.read()).items).filter((item) => item.kind !== "confirm_address");
    expect(approverItems.map((item) => [item.kind, item.who])).toEqual([
      ["decision", "You can decide it"],
      ["decision", "You can decide it"],
    ]);
    expect(asApprover.fake.requests.some((sent) => sent.path === "/rest/v1/payment_approvals")).toBe(false);

    const off = world(INVITED, harbor({ cosignOn: false }));
    expect(harborItems((await off.read()).items).map((item) => item.kind)).toEqual(["decision", "decision"]);
    expect(off.fake.requests.some((sent) => sent.path === "/rest/v1/payment_approvals" || sent.path === "/rest/v1/payment_intents")).toBe(false);
  });

  it("keeps the decision items, and names the part, when the co-sign facts cannot be read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { read } = world(INVITED, harbor({ failing: "/rest/v1/payment_intents" }));
    const portfolio = await read();
    expect(harborItems(portfolio.items).map((item) => item.kind)).toEqual(["decision", "decision"]);
    expect(portfolio.workspaces.find((workspace) => workspace.slug === HARBOR.slug)?.unread).toEqual(["bills to co-sign"]);
  });

  it("counts co-signing as off when the setting cannot be read, and names it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, read } = world(INVITED, harbor({ failing: "/rest/v1/approval_policies", counterparties: [{ id: "cp-1", name: "Northwind", address_changed_at: "2026-10-12T08:00:00Z", address_confirmed_at: null }] }));
    const portfolio = await read();
    expect(harborItems(portfolio.items).map((item) => item.kind)).toEqual(["decision", "decision"]);
    expect(portfolio.workspaces.find((workspace) => workspace.slug === HARBOR.slug)?.unread).toEqual(["the co-sign setting"]);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/counterparties" && sent.params.get("address_changed_at"))).toBe(false);
  });

  it("lists each changed address no one confirmed, without the address, and a frozen payee as waiting on an owner or admin", async () => {
    const counterparties = [
      { id: "cp-new", name: "Northwind", address_changed_at: "2026-10-12T08:00:00Z", address_confirmed_at: null },
      { id: "cp-done", name: "Confirmed Co", address_changed_at: "2026-10-11T08:00:00Z", address_confirmed_at: "2026-10-11T09:00:00Z" },
      { id: "cp-frozen", name: "Frozen Ltd", address_changed_at: "2026-10-01T08:00:00Z", address_confirmed_at: "2026-09-01T08:00:00Z" },
    ];
    const { fake, read } = world(INVITED, harbor({ payables: [], counterparties, frozen: ["cp-frozen"] }));
    const items = harborItems((await read()).items);
    expect(items).toEqual([
      expect.objectContaining({
        key: "harbor-bakery:confirm_address:cp-new",
        kind: "confirm_address",
        title: "Northwind",
        detail: "Its address changed on Oct 12, 2026. The agent pays nothing to it until someone confirms it.",
        amount: null,
        since: "2026-10-12T08:00:00Z",
        href: "/o/harbor-bakery/counterparties#counterparty-cp-new",
        canAct: true,
        who: "You can confirm it",
      }),
      expect.objectContaining({
        kind: "confirm_address",
        title: "Frozen Ltd",
        detail: "Its address changed on Oct 1, 2026, and its contact said they did not make the change. It is unfrozen before it is confirmed.",
        canAct: false,
        who: "Waiting on an owner or admin of this workspace",
      }),
    ]);
    for (const item of items) expect(item.detail).not.toMatch(/0x/i);
    const asked = fake.requests.find((sent) => sent.path === "/rest/v1/counterparties" && sent.params.get("address_changed_at"))!;
    expect(asked.params.get("address_changed_at")).toBe("not.is.null");
    expect(asked.params.get("select")).not.toContain("address,");
    expect(asked.params.get("limit")).toBe("200");
  });

  it("lists changed addresses to whoever decides payments, and lets an owner unfreeze a frozen one", async () => {
    const counterparties = [
      { id: "cp-new", name: "Northwind", address_changed_at: "2026-10-12T08:00:00Z", address_confirmed_at: null },
      { id: "cp-frozen", name: "Frozen Ltd", address_changed_at: "2026-10-01T08:00:00Z", address_confirmed_at: null },
    ];
    const asOwner = INVITED.map((row) => (row.user === ACCOUNTANT && row.org.slug === HARBOR.slug ? { ...row, role: "owner" } : row));
    const { read } = world(asOwner, harbor({ cosignOn: false, payables: [], counterparties, frozen: ["cp-frozen"] }));
    expect(harborItems((await read()).items).map((item) => [item.title, item.canAct, item.who])).toEqual([
      ["Frozen Ltd", true, "You can unfreeze it once you have checked with them, then confirm it"],
      ["Northwind", true, "You can confirm it"],
    ]);
  });

  it("under the payee lock, leaves an address the viewer entered to another member, as the confirmation refuses it, and lets them confirm it alone where no one else may", async () => {
    const counterparties = [
      { id: "cp-mine", name: "Northwind", address_changed_at: "2026-10-12T08:00:00Z", address_confirmed_at: null },
      { id: "cp-theirs", name: "Pixel Print", address_changed_at: "2026-10-11T08:00:00Z", address_confirmed_at: null },
    ];
    const asOwner = INVITED.map((row) => (row.user === ACCOUNTANT && row.org.slug === HARBOR.slug ? { ...row, role: "owner" } : row));
    const lockWorld = (othersWhoConfirm: number) =>
      world(asOwner, (sent) => {
        const inHarbor = claimsOf(sent)?.org_id === HARBOR.id;
        // The addresses, read only to know who gave each; and the entries that set them, the viewer's for Northwind.
        if (inHarbor && sent.path === "/rest/v1/counterparties" && sent.params.get("select") === "id,address") {
          return { body: [{ id: "cp-mine", address: "0xnew1" }, { id: "cp-theirs", address: "0xnew2" }] };
        }
        if (inHarbor && sent.path === "/rest/v1/ledger_entries" && sent.params.get("action")?.includes("counterparty_address_changed")) {
          return {
            body: [
              { action: "counterparty_address_changed", detail: { by: ACCOUNTANT, counterpartyId: "cp-mine", from: "0xold1", to: "0xnew1" } },
              { action: "counterparty_address_changed", detail: { by: OWNER, counterpartyId: "cp-theirs", from: "0xold2", to: "0xnew2" } },
            ],
          };
        }
        if (inHarbor && (sent.path === "/rest/v1/rpc/approvers_besides" || sent.path === "/rest/v1/rpc/cosigners_besides")) return { body: othersWhoConfirm };
        return harbor({ cosignOn: false, lock: true, payables: [], counterparties })(sent);
      });

    const { fake, read } = lockWorld(1);
    const portfolio = await read();
    expect(harborItems(portfolio.items).map((item) => [item.title, item.canAct, item.who])).toEqual([
      ["Pixel Print", true, "You can confirm it"],
      ["Northwind", false, "Waiting on another member to confirm it: you entered or asked for this address"],
    ]);
    // Not among what the viewer can act on, and no address on any item.
    expect(portfolio.items.filter((item) => item.canAct).map((item) => item.title)).toEqual(["Pixel Print"]);
    for (const item of harborItems(portfolio.items)) expect(item.detail).not.toMatch(/0x/i);
    // Who else may confirm is asked once, leaving out the viewer.
    const asked = fake.requests.filter((sent) => sent.path === "/rest/v1/rpc/approvers_besides" && claimsOf(sent)?.org_id === HARBOR.id);
    expect(asked).toHaveLength(1);
    expect((asked[0].body as { p_excluded: string[] }).p_excluded).toEqual([ACCOUNTANT]);

    // With no one else to confirm it, the viewer confirms it alone, as a solo confirmation.
    const alone = lockWorld(0);
    expect(harborItems((await alone.read()).items).map((item) => [item.title, item.canAct])).toEqual([
      ["Pixel Print", true],
      ["Northwind", true],
    ]);
  });

  it("reads no address, and no one who gave one, while the payee lock is off", async () => {
    const counterparties = [{ id: "cp-mine", name: "Northwind", address_changed_at: "2026-10-12T08:00:00Z", address_confirmed_at: null }];
    const asOwner = INVITED.map((row) => (row.user === ACCOUNTANT && row.org.slug === HARBOR.slug ? { ...row, role: "owner" } : row));
    const { fake, read } = world(asOwner, harbor({ cosignOn: false, payables: [], counterparties }));
    expect(harborItems((await read()).items).map((item) => [item.title, item.canAct])).toEqual([["Northwind", true]]);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/counterparties" && sent.params.get("select") === "id,address")).toBe(false);
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/ledger_entries" && sent.params.get("action")?.includes("counterparty_address_changed"))).toBe(false);
  });
});
