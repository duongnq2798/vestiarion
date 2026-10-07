import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMembership } from "@/lib/auth/membership";
import { activeLine, byRecentActivity } from "@/lib/workspace-recency";

/**
 * The workspaces page, /onboarding (docs/superpowers/specs/2026-10-07-workspaces-page-design.md): someone with
 * workspaces is welcomed back to the one in use most recently, and creating another waits behind a button; someone with
 * none is welcomed and creates their first.
 */

const { redirect, memberships } = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  memberships: { value: [] as OrgMembership[] },
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect, useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/onboarding" }));
vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn(async () => ({ id: "u1", email: "dana@example.com" })) }));
vi.mock("@/lib/auth/membership", () => ({ membershipsOf: vi.fn(async () => memberships.value) }));
vi.mock("@/lib/platform/members", () => ({ pendingInvitationsFor: vi.fn(async () => []) }));
vi.mock("@/lib/context", () => ({ currentConfig: () => ({ mainnetEnabled: false, mainnetAllowlist: [] }) }));
vi.mock("@/app/onboarding/actions", () => ({ createWorkspaceAction: vi.fn() }));
vi.mock("@/components/vx/AccountMenu", () => ({ AccountMenu: () => null }));
vi.mock("@/components/AcceptInvitationByIdForm", () => ({ default: () => null }));

import OnboardingPage from "@/app/onboarding/page";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const NOW = Date.parse("2026-10-07T12:00:00Z");
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

function workspace(slug: string, hoursAgo: number | null, extra: Partial<OrgMembership> = {}): OrgMembership {
  return {
    orgId: slug,
    slug,
    name: slug,
    mode: "live",
    role: "owner",
    network: "arc-testnet",
    ...(hoursAgo === null ? {} : { lastActiveAt: ago(hoursAgo) }),
    ...extra,
  };
}

async function render(query: Record<string, string> = {}) {
  return renderToStaticMarkup(await OnboardingPage({ searchParams: Promise.resolve(query) }));
}

/** The workspace names in the order the page lists them. */
const listed = (markup: string) => [...markup.matchAll(/href="\/o\/([^/"]+)\/[^"]*"/g)].map((match) => match[1]);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  redirect.mockClear();
});

describe("how recently a workspace was in use", () => {
  it("never claims more than the hourly refresh can tell", () => {
    expect(activeLine(ago(0.2), NOW)).toBe("Active in the last hour");
    expect(activeLine(ago(1), NOW)).toBe("Active 1 hour ago");
    expect(activeLine(ago(5.5), NOW)).toBe("Active 5 hours ago");
    expect(activeLine(ago(30), NOW)).toBe("Active yesterday");
    expect(activeLine(ago(24 * 9), NOW)).toBe("Active 9 days ago");
    expect(activeLine(ago(24 * 40), NOW)).toBe("Last active Aug 28, 2026");
    // A clock a little ahead of the database's is still the last hour, and a bad value says nothing.
    expect(activeLine(new Date(NOW + 60_000).toISOString(), NOW)).toBe("Active in the last hour");
    expect(activeLine("not a time", NOW)).toBe("");
  });

  it("orders the most recent first, one without a time last, and a tie by name", () => {
    const order = byRecentActivity([workspace("b", 5), workspace("none", null), workspace("a", 5), workspace("new", 1)]).map((item) => item.slug);
    expect(order).toEqual(["new", "a", "b", "none"]);
  });
});

describe("the workspaces page", () => {
  it("welcomes someone with no workspace and shows the form to create their first", async () => {
    memberships.value = [];
    const markup = await render();
    expect(text(markup)).toContain("Welcome to Vestiarion");
    expect(text(markup)).toContain("Create your first workspace to run Vestiarion.");
    expect(markup).toContain('id="create-workspace"');
    expect(markup).not.toContain("<details");
    expect(markup).toContain('name="name"');
  });

  it("welcomes back someone with workspaces, most recent first and marked, each with when it was last in use", async () => {
    memberships.value = [workspace("old", 24 * 9), workspace("now", 0.5), workspace("today", 5, { network: "arc-mainnet" })];
    const markup = await render({ new: "" });
    const page = text(markup);
    expect(page).toContain("Welcome back");
    expect(page).toContain("Choose a workspace to continue.");
    expect(listed(markup)).toEqual(["now", "today", "old"]);
    expect(page).toMatch(/now Most recent Live Arc testnet owner Active in the last hour/);
    expect(page).toMatch(/today Live Arc mainnet owner Active 5 hours ago/);
    expect(page.match(/Most recent/g)).toHaveLength(1);
    // Three or fewer: one list, no headings.
    expect(page).not.toContain("Other workspaces");
  });

  it("leads with the three most recent and lists the rest under other workspaces", async () => {
    memberships.value = ["echo", "delta", "charlie", "bravo", "alpha"].map((slug, index) => workspace(slug, index + 1));
    const markup = await render({ new: "" });
    const page = text(markup);
    expect(page.indexOf("Recent")).toBeLessThan(page.indexOf("echo Most recent"));
    expect(page.indexOf("charlie")).toBeLessThan(page.indexOf("Other workspaces"));
    expect(page.indexOf("Other workspaces")).toBeLessThan(page.indexOf("bravo"));
    expect(listed(markup)).toEqual(["echo", "delta", "charlie", "bravo", "alpha"]);
  });

  it("keeps creating another workspace behind a button, open when the switcher asks to create one", async () => {
    memberships.value = [workspace("alpha", 1), workspace("bravo", 2)];
    const closed = await render({ new: "" });
    expect(closed).toMatch(/<details id="create-workspace"(?![^>]*\sopen)[^>]*>/);
    expect(text(closed)).toContain("Create a new workspace");
    const open = await render({ create: "" });
    expect(open).toMatch(/<details id="create-workspace"[^>]*\sopen=""/);
  });

  it("still sends someone with one workspace straight in, unless they came to list or create", async () => {
    memberships.value = [workspace("solo", 1)];
    await expect(render()).rejects.toThrow("redirect:/o/solo/");
    await expect(render({ new: "" })).resolves.toContain("Welcome back");
    await expect(render({ create: "" })).resolves.toContain("Welcome back");
  });
});
