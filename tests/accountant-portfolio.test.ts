import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { TENANT_TABLES } from "@/lib/dal";
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

function world(memberships: Membership[]) {
  const fake = fakeSupabase((sent): FakeReply => {
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
