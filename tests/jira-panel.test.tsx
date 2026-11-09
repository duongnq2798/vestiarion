import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMembership } from "@/lib/auth/membership";
import type { PendingChoice } from "@/lib/connectors/token-store";

const { memberships, actions, jiraOn, pending } = vi.hoisted(() => ({
  memberships: { value: [] as OrgMembership[] },
  actions: {
    disconnectJiraAction: vi.fn(),
    syncJiraNowAction: vi.fn(),
    linkJiraIssueAction: vi.fn(),
    unlinkJiraIssueAction: vi.fn(),
    setJiraCriteriaAction: vi.fn(),
    acceptJiraWorkAction: vi.fn(),
    checkJiraIssueAction: vi.fn(),
  },
  jiraOn: { value: true },
  pending: { value: null as PendingChoice | null },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/jira", () => actions);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn(async () => ({ id: "u1", email: "dana@example.com" })) }));
vi.mock("@/lib/auth/membership", () => ({ membershipsOf: vi.fn(async () => memberships.value) }));
vi.mock("@/lib/jira/settings", async (original) => ({
  ...(await original<typeof import("@/lib/jira/settings")>()),
  jiraSettingsFromEnv: () => (jiraOn.value ? { clientId: "jIrAcLiEnT0123", clientSecret: "s" } : null),
}));
vi.mock("@/lib/connectors/token-store", () => ({ pendingChoice: vi.fn(async () => pending.value) }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: (_org: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/components/vx/SiteChrome", () => ({ SiteHeader: () => null, SiteFooter: () => null }));

import JiraIntegrationPage from "@/app/integrations/jira/page";
import JiraConnectPage from "@/app/integrations/jira/connect/page";
import JiraPanel, { JIRA_NOTICES } from "@/components/JiraPanel";
import { JiraIssueCard } from "@/components/JiraIssueCard";
import { LINK_ACCEPTED, LINK_HELD, LINK_READY, MEMBER_EMAILS, RETRIES_CRITERIA } from "@/app/docs-shots/jira-fixture";
import { CONSENT_VERSIONS, consentStatement } from "@/lib/connectors/consent";
import type { IssueLink } from "@/lib/jira/links";
import { jiraMilestoneView, type JiraPanelView } from "@/lib/jira/views";
import { workToolCards } from "@/lib/work-tool-cards";

/**
 * Jira's Settings card, a milestone's Jira card on Contractors, and the launch and connect pages
 * (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR2, JR6, JR7, JR11, JR13, JR21, JR22), as Linear's:
 * each state in words, the controls for whoever may use them, each form posting the fields its server action reads, and
 * Jira's name beside the product's icon for work tools, never an Atlassian logo. And which work tool's card a milestone
 * offers, now among three.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const buttons = (markup: string) => [...markup.matchAll(/<(?:button|a)\b[^>]*>([^]*?)<\/(?:button|a)>/g)].map((match) => text(match[1]).trim()).filter(Boolean);
/** Every `<input>`'s attributes. */
const inputs = (markup: string): Array<Record<string, string>> =>
  [...markup.matchAll(/<input\b([^>]*)>/g)].map((match) => Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((attribute) => [attribute[1], attribute[2] ?? ""])));
/** The forms of a markup, each as its action, its inputs' names and its buttons' words. */
const forms = (markup: string) =>
  [...markup.matchAll(/<form\b([^>]*)>([^]*?)<\/form>/g)].map((match) => ({
    names: [...inputs(match[2]), ...[...match[2].matchAll(/<textarea\b([^>]*)>/g)].map((area) => ({ name: area[1].match(/name="([^"]*)"/)?.[1] ?? "" }))].map((input) => input.name).sort(),
    buttons: buttons(match[2]),
  }));
const labelFor = (markup: string, id: string) => {
  const match = markup.match(new RegExp(`<label[^>]*for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^]*?)</label>`));
  return match ? text(match[1]).trim() : null;
};

const card = (view: JiraPanelView, canManage = true, notice: string | null = null) => renderToStaticMarkup(<JiraPanel orgSlug="acme" view={view} canManage={canManage} notice={notice} />);

const connected = (fields: Partial<Extract<JiraPanelView, { state: "connection" }>> = {}): JiraPanelView => ({
  state: "connection",
  status: { tone: "ok", title: "Connected to the Northstar site in Jira", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  siteName: "Northstar",
  siteHost: "northstar.atlassian.net",
  noticeLine: "Jira last told Vestiarion of a change Nov 9, 2026, 10:20 UTC.",
  counts: { linked: 3, ready: 1, accepted: 1, held: 1 },
  figures: { manualChecks: 3, disputes: 1, timeToProposal: "2 minutes", window: "the last 30 days" },
  ...fields,
});

const workspace = (slug: string, role: OrgMembership["role"] = "owner"): OrgMembership => ({
  orgId: `org-${slug}`,
  slug,
  name: slug === "acme" ? "Acme Studio" : "Beta Works",
  mode: "live",
  role,
  network: "arc-testnet",
});

beforeEach(() => {
  memberships.value = [];
  jiraOn.value = true;
  pending.value = null;
});

describe("the Jira card in Settings (Jira acceptance JR2, JR21, JR22)", () => {
  it("is headed Jira in words beside the icon for work tools, with the guide, and no logo", () => {
    const markup = card({ state: "not_connected" });
    expect(markup).toContain('id="jira"');
    expect(markup).toContain('aria-labelledby="jira-title"');
    expect(markup).toMatch(/id="jira-title"[^>]*>[^]*?lucide-square-kanban[^]*?Jira/);
    expect(markup).toContain('href="/docs/guides/jira"');
    expect(markup).not.toContain("/brands/");
  });

  it("says when it is not set up, with no button", () => {
    const markup = card({ state: "not_set_up" });
    expect(text(markup)).toContain("Jira is not set up on this deployment yet.");
    expect(markup).not.toContain("/integrations/jira/connect");
  });

  it("offers Connect Jira to an owner or admin, naming the workspace, and says who connects it to others", () => {
    const markup = card({ state: "not_connected" });
    expect(text(markup)).toContain(
      "Pay contractors for work delivered in Jira. An issue marked done alone never pays: a person accepts the work against the milestone's criteria."
    );
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/jira\/connect\?org=acme"[^>]*>[^]*?Connect Jira/);
    const other = card({ state: "not_connected" }, false);
    expect(text(other)).toContain("An owner or admin connects Jira.");
    expect(other).not.toContain("/integrations/jira/connect");
  });

  it("names the site and its host, says whether Jira's notices arrive, counts the linked issues and shows the figures", () => {
    const words = text(card(connected()));
    expect(words).toContain("Connected to the Northstar site in Jira");
    expect(words).toContain("Site: northstar.atlassian.net");
    expect(words).toContain("Jira last told Vestiarion of a change Nov 9, 2026, 10:20 UTC.");
    expect(words).toContain("3 issues linked to milestones");
    expect(words).toContain("1 issue ready for acceptance");
    expect(words).toContain("1 issue held for review");
    expect(words).toContain("Evidence checked by a person 3 acceptances");
    expect(words).toContain("Disputes 1 acceptance taken back");
    expect(words).toContain("From acceptance to the agent's decision 2 minutes");
    expect(card(connected())).toMatch(/<a[^>]*href="\/o\/acme\/contractors"[^>]*>3 issues linked to milestones<\/a>/);
    const quiet = text(card(connected({ noticeLine: null, counts: { linked: 0, ready: 0, accepted: 0, held: 0 } })));
    expect(quiet).toContain("No milestone is linked to a Jira issue yet.");
    expect(quiet).not.toContain("told Vestiarion");
  });

  it("gives an owner or admin Check linked issues now and Disconnect Jira, each posting the workspace, and others neither", () => {
    const markup = card(connected());
    expect(buttons(markup)).toEqual(expect.arrayContaining(["Check linked issues now", "Disconnect Jira"]));
    for (const form of forms(markup)) expect(form.names).toEqual(["orgSlug"]);
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "orgSlug", value: "acme" }));
    const other = card(connected(), false);
    expect(buttons(other)).not.toContain("Disconnect Jira");
    expect(buttons(other)).not.toContain("Check linked issues now");
    expect(text(other)).toContain("An owner or admin manages Jira.");
  });

  it("offers Reconnect Jira when Jira no longer takes the connection, and Connect Jira once disconnected", () => {
    const reconnect = card(connected({ connected: false, status: { tone: "error", title: "Jira needs you to reconnect", detail: [], reconnect: true } }));
    expect(reconnect).toMatch(/<a[^>]*href="\/integrations\/jira\/connect\?org=acme"[^>]*>[^]*?Reconnect Jira/);
    expect(buttons(reconnect)).not.toContain("Check linked issues now");
    const revoked = card(
      connected({ connected: false, revoked: true, noticeLine: null, status: { tone: "off", title: "Disconnected from the Northstar site in Jira", detail: [], reconnect: false } })
    );
    expect(revoked).toMatch(/<a[^>]*href="\/integrations\/jira\/connect\?org=acme"[^>]*>[^]*?Connect Jira/);
    expect(buttons(revoked)).not.toContain("Disconnect Jira");
    expect(text(revoked)).not.toContain("linked to milestones");
    expect(text(revoked)).not.toContain("Site: ");
  });

  it("says how connecting went, for every way back the connect flow has for Jira", () => {
    // The core's ways back (src/lib/connectors/connect.ts), and Jira's own refusal when the grant reaches no site (JR2).
    // Jira is not exclusive, so never other_workspace; it writes nothing, so never writing or write_not_granted.
    expect(Object.keys(JIRA_NOTICES).sort()).toEqual(["cancelled", "connected", "failed", "forbidden", "no_site", "not_set_up", "other_organisation"]);
    expect(text(card({ state: "not_connected" }, true, "connected"))).toContain("Jira is connected. Link a milestone to its Jira issue on Contractors.");
    expect(card({ state: "not_connected" }, true, "cancelled")).toMatch(/<p role="status" class="text-sm text-refused">Connecting Jira was cancelled. Nothing changed.<\/p>/);
    expect(text(card({ state: "not_connected" }, true, "other_organisation"))).toContain("This workspace is connected to another Jira site.");
    expect(text(card({ state: "not_connected" }, true, "no_site"))).toContain(
      "Your Atlassian account has no Jira site Vestiarion can read. Connect with the account you use Jira with, or ask the site's admin whether apps are allowed."
    );
    expect(text(card({ state: "not_connected" }, true, "unknown"))).not.toContain("Jira is connected.");
  });
});

const view = (link: IssueLink | null, fields: { status?: string; criteria?: string | null; connected?: boolean; canWrite?: boolean } = {}) =>
  jiraMilestoneView({
    milestone: { id: "m-1", status: fields.status ?? "pending", acceptance_criteria: fields.criteria === undefined ? RETRIES_CRITERIA : fields.criteria },
    link,
    connected: fields.connected ?? true,
    canWrite: fields.canWrite ?? true,
    links: null,
    memberEmails: MEMBER_EMAILS,
  });
const issueCard = (milestoneView: ReturnType<typeof view>) => renderToStaticMarkup(<JiraIssueCard orgSlug="acme" milestoneId="m-1" view={milestoneView} />);

describe("a milestone's Jira card on Contractors (Jira acceptance JR6, JR7, JR11, JR13, JR22)", () => {
  it("links an issue by its link or its key, posting `issue`, and takes the criteria from the agreement", () => {
    const markup = issueCard(view(null, { criteria: null }));
    expect(markup).toContain('data-jira-state="unlinked"');
    expect(markup).toContain("lucide-square-kanban");
    expect(markup).not.toContain("/brands/");
    expect(text(markup)).toContain("Accept from Jira");
    expect(text(markup)).toContain("Paste the issue's link or its key. Vestiarion reads the issue through Jira with this workspace's connection, never by opening the link.");
    const [link, criteria] = forms(markup);
    expect(link).toEqual({ names: ["issue", "milestoneId", "orgSlug"], buttons: ["Link the issue"] });
    expect(criteria).toEqual({ names: ["criteria", "milestoneId", "orgSlug"], buttons: ["Add the criteria"] });
    // A text field, so a key like ENG-123 is taken as well as a link.
    expect(inputs(markup).find((input) => input.name === "issue")).toMatchObject({ type: "text", required: "", maxLength: "1000" });
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "milestoneId", value: "m-1" }));
  });

  it("asks to connect Jira when it is not connected, and shows nothing to whoever may not verify milestones", () => {
    expect(text(issueCard(view(null, { connected: false })))).toContain("Connect Jira in Settings, Integrations, to accept this work from a Jira issue.");
    expect(forms(issueCard(view(null, { connected: false })))).toEqual([]);
    expect(issueCard(view(null, { canWrite: false }))).toBe("");
  });

  it("offers Accept the work on a done issue with criteria, posting the fingerprint and the criteria's hash shown (JR11)", () => {
    const shown = view(LINK_READY);
    const markup = issueCard(shown);
    expect(markup).toContain('data-jira-state="ready"');
    expect(text(markup)).toContain("Jira issue ENG-142: Webhook retries with backoff");
    expect(markup).toMatch(/<a href="https:\/\/northstar\.atlassian\.net\/browse\/ENG-142" target="_blank" rel="noreferrer"/);
    expect(text(markup)).toContain("Done in Jira on Nov 9, 2026 (Done, resolved as Done).");
    expect(text(markup)).toContain("On northstar.atlassian.net.");
    expect(text(markup)).toContain("Read from Jira Nov 9, 2026, 10:25 UTC.");
    expect(text(markup)).toContain("Deliverables in Jira");
    expect(text(markup)).toContain("Attachment: webhook-retries-design.pdf");
    expect(text(markup)).toContain("Web link: Retry failed webhook deliveries with backoff #318");
    expect(text(markup)).toContain("Link in the description: docs-preview.northstar.example/webhooks/retries");
    expect(text(markup)).toContain("Link in a comment: docs-preview.northstar.example/runbooks/webhook-retries");
    expect(text(markup)).toContain("I checked each criterion against these deliverables, as shown here.");
    expect(text(markup)).toContain("nothing from Jira sets the amount or the payee.");
    const accept = forms(markup).find((form) => form.buttons.includes("Accept the work"));
    expect(accept?.names).toEqual(["confirmed", "criteriaSha256", "fingerprint", "milestoneId", "orgSlug"]);
    expect(inputs(markup).find((input) => input.name === "confirmed")).toMatchObject({ value: "yes" });
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "fingerprint", value: LINK_READY.fingerprint as string }));
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "criteriaSha256", value: shown.linked ? (shown.criteriaSha256 as string) : "" }));
    expect(buttons(markup)).toEqual(expect.arrayContaining(["Check Jira now", "Unlink the issue"]));
    for (const form of forms(markup).filter((each) => each.buttons.includes("Check Jira now") || each.buttons.includes("Unlink the issue"))) {
      expect(form.names).toEqual(["milestoneId", "orgSlug"]);
    }
  });

  it("offers no acceptance without criteria, and holds the issue for them", () => {
    const markup = issueCard(view({ ...LINK_READY, state: "held", heldReason: "no_criteria" }, { criteria: null }));
    expect(buttons(markup)).not.toContain("Accept the work");
    expect(text(markup)).toContain("The issue is done, but the milestone has no acceptance criteria.");
    expect(buttons(markup)).toContain("Add the criteria");
  });

  it("holds an issue Jira resolved as not done, naming the resolution, and offers no acceptance (JR9)", () => {
    const markup = issueCard(view({ ...LINK_READY, state: "held", heldReason: "canceled", completed: false, completedAt: null, statusName: "Closed", resolutionName: "Won't Do" }));
    expect(text(markup)).toContain("Jira resolved the issue as Won't Do, which is not done.");
    expect(text(markup)).toContain("Resolved in Jira as Won't Do (Closed): not done.");
    expect(buttons(markup)).not.toContain("Accept the work");
  });

  it("shows an accepted issue's deliverables as accepted, who accepted them, and its criteria fixed", () => {
    const markup = issueCard(view(LINK_ACCEPTED, { status: "verified" }));
    expect(markup).toContain('data-jira-state="accepted"');
    expect(text(markup)).toContain("Deliverables accepted");
    expect(text(markup)).toContain("Accepted on Nov 9, 2026 by adam@northstar.example.");
    expect(buttons(markup)).not.toContain("Accept the work");
    expect(buttons(markup)).not.toContain("Save the criteria");
    expect(text(markup)).toContain("Acceptance criteria Failed webhook deliveries are retried 5 times");
    expect(text(markup)).toContain("To take the acceptance back, unlink the issue: the milestone then waits for verification again.");
  });

  it("holds a reopened issue for review, and lets a person accept it again only once it is done again (JR13)", () => {
    const markup = issueCard(view(LINK_HELD));
    expect(markup).toContain('data-jira-state="held"');
    expect(text(markup)).toContain("Held for review");
    expect(text(markup)).toContain("The issue was reopened in Jira after the work was accepted");
    expect(text(markup)).toContain("In Progress in Jira: not done yet.");
    expect(buttons(markup)).not.toContain("Accept the work");
    const doneAgain = issueCard(view({ ...LINK_HELD, completed: true, completedAt: "2026-11-09T11:00:00.000Z", statusCategory: "done", statusName: "Done", resolutionName: "Done" }));
    expect(buttons(doneAgain)).toContain("Accept the work");
  });

  it("shows a linked issue without controls to whoever may not verify milestones", () => {
    const markup = issueCard(view(LINK_READY, { canWrite: false }));
    expect(text(markup)).toContain("Ready for acceptance");
    expect(forms(markup)).toEqual([]);
  });

  it("leaves the criteria to the card that asks for them when several offer to link the milestone, naming it", () => {
    const fromLinear = renderToStaticMarkup(<JiraIssueCard orgSlug="acme" milestoneId="m-1" view={view(null)} withCriteria={false} criteriaIn="Linear" />);
    expect(forms(fromLinear)).toEqual([{ names: ["issue", "milestoneId", "orgSlug"], buttons: ["Link the issue"] }]);
    expect(fromLinear).not.toContain("Acceptance criteria, from the agreement");
    expect(text(fromLinear)).toContain("The acceptance criteria are the milestone's, written once under Accept from Linear: the work is held to them in Jira too.");
    const fromAsana = renderToStaticMarkup(<JiraIssueCard orgSlug="acme" milestoneId="m-1" view={view(null)} withCriteria={false} />);
    expect(text(fromAsana)).toContain("written once under Accept from Asana: the work is held to them in Jira too.");
    // A linked issue keeps its own criteria field until the work is accepted.
    const linked = renderToStaticMarkup(
      <JiraIssueCard orgSlug="acme" milestoneId="m-1" view={view({ ...LINK_READY, state: "held", heldReason: "no_criteria" }, { criteria: null })} withCriteria={false} />
    );
    expect(buttons(linked)).toContain("Add the criteria");
  });
});

describe("which work tool's card a milestone offers, among three (Jira acceptance JR6, JR22)", () => {
  const tool = (connected: boolean, linked = false) => ({ connected, linked });

  it("shows only Jira's card on a milestone linked in Jira, whatever else is connected", () => {
    for (const pending of [true, false]) {
      expect(workToolCards({ pending, asana: tool(true), linear: tool(true), jira: tool(true, true) })).toEqual({
        asana: false,
        linear: false,
        jira: true,
        linearCriteria: false,
        jiraCriteria: true,
      });
    }
    // And no Jira card on a milestone linked in Linear or Asana.
    expect(workToolCards({ pending: true, asana: tool(true), linear: tool(true, true), jira: tool(true) })).toMatchObject({ asana: false, linear: true, jira: false, jiraCriteria: false });
    expect(workToolCards({ pending: true, asana: tool(true, true), linear: tool(true), jira: tool(true) })).toMatchObject({ asana: true, linear: false, jira: false, jiraCriteria: false });
  });

  it("shows Linear's and Jira's cards when both are connected and neither is linked, asking for the criteria once, on Linear's", () => {
    expect(workToolCards({ pending: true, asana: null, linear: tool(true), jira: tool(true) })).toEqual({ asana: false, linear: true, jira: true, linearCriteria: true, jiraCriteria: false });
    // Asana configured, not connected: its card is not offered, and the criteria stay on Linear's.
    expect(workToolCards({ pending: true, asana: tool(false), linear: tool(true), jira: tool(true) })).toEqual({ asana: false, linear: true, jira: true, linearCriteria: true, jiraCriteria: false });
  });

  it("lets Asana, connected, ask for the criteria on its own card, and the others leave them to it", () => {
    expect(workToolCards({ pending: true, asana: tool(true), linear: tool(true), jira: tool(true) })).toEqual({ asana: true, linear: true, jira: true, linearCriteria: false, jiraCriteria: false });
    expect(workToolCards({ pending: true, asana: tool(true), linear: null, jira: tool(true) })).toEqual({ asana: true, linear: false, jira: true, linearCriteria: false, jiraCriteria: false });
    expect(workToolCards({ pending: true, asana: tool(true), linear: tool(false), jira: tool(true) })).toEqual({ asana: true, linear: false, jira: true, linearCriteria: false, jiraCriteria: false });
  });

  it("offers Jira's card alone where Jira alone is connected, and every card where none is", () => {
    expect(workToolCards({ pending: true, asana: tool(false), linear: tool(false), jira: tool(true) })).toEqual({ asana: false, linear: false, jira: true, linearCriteria: false, jiraCriteria: true });
    expect(workToolCards({ pending: true, asana: null, linear: null, jira: tool(false) })).toEqual({ asana: false, linear: false, jira: true, linearCriteria: false, jiraCriteria: true });
    expect(workToolCards({ pending: true, asana: tool(false), linear: tool(false), jira: tool(false) })).toEqual({ asana: true, linear: true, jira: true, linearCriteria: true, jiraCriteria: false });
  });

  it("keeps a linked Jira card on a milestone no longer open, as its history, and offers none to link one", () => {
    expect(workToolCards({ pending: false, asana: tool(true), linear: tool(true), jira: tool(true, true) })).toMatchObject({ jira: true });
    expect(workToolCards({ pending: false, asana: null, linear: null, jira: tool(true) })).toMatchObject({ jira: false, jiraCriteria: false });
  });

  it("leaves every two-tool answer as it was where Jira is not configured", () => {
    for (const asana of [tool(true), tool(false), tool(true, true), null]) {
      for (const linear of [tool(true), tool(false), tool(true, true), null]) {
        for (const pending of [true, false]) {
          const without = workToolCards({ pending, asana, linear });
          expect(workToolCards({ pending, asana, linear, jira: null })).toEqual(without);
          expect(without).toMatchObject({ jira: false, jiraCriteria: false });
        }
      }
    }
  });
});

describe("the Jira launch page (Jira acceptance JR1, JR2)", () => {
  it("takes a person with one workspace straight to its Jira card", async () => {
    memberships.value = [workspace("acme")];
    await expect(JiraIntegrationPage()).rejects.toThrow("redirect /o/acme/settings#jira");
  });

  it("lets a person with several workspaces pick one, headed by Jira's name beside the icon for work tools", async () => {
    memberships.value = [workspace("acme"), workspace("beta")];
    const markup = renderToStaticMarkup(await JiraIntegrationPage());
    expect(markup).toMatch(/<h1[^>]*>[^]*?lucide-square-kanban[^]*?Jira<\/h1>/);
    expect(markup).not.toContain("/brands/");
    expect(markup).toContain('href="/o/acme/settings#jira"');
    expect(markup).toContain('href="/o/beta/settings#jira"');
    expect(text(markup)).toContain("Pick the workspace whose Jira settings you want.");
  });

  it("says Jira is not set up where it is not configured, and goes nowhere (JR1)", async () => {
    jiraOn.value = false;
    memberships.value = [workspace("acme")];
    const markup = renderToStaticMarkup(await JiraIntegrationPage());
    expect(text(markup)).toContain("Jira is not set up on this deployment yet.");
    expect(markup).not.toContain("/settings#jira");
  });
});

const connectPage = async (query: Record<string, string> = {}) => renderToStaticMarkup(await JiraConnectPage({ searchParams: Promise.resolve(query) }));
const CHOICE = "0b6c1c9e-4a4f-4a7e-9b1e-000000000d09";

describe("the Jira connect page (Jira acceptance JR1, JR2, JR22)", () => {
  it("names Jira in words beside the icon for work tools, says what it reads, and goes to Jira", async () => {
    memberships.value = [workspace("acme")];
    const markup = await connectPage();
    const words = text(markup);
    expect(markup).toMatch(/<h1[^>]*>[^]*?lucide-square-kanban[^]*?Connect Jira[^]*?<\/h1>/);
    expect(markup).not.toContain("/brands/");
    expect(words).toContain(
      "Pay contractors for work delivered in Jira. You link a milestone to its Jira issue; when the issue is done, a person accepts the work against the milestone's criteria, and only then does the agent decide on pay, under every guardrail."
    );
    expect(words).toContain("What Vestiarion does with Jira's data");
    for (const line of consentStatement("jira")) expect(words).toContain(line);
    expect(words).toContain(
      "Atlassian asks you to allow access as yourself to one Jira site: Vestiarion sees the issues you can see there, and reads only the ones linked to milestones."
    );
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>[^]*?Continue to Jira<\/button>/);
    expect(words).toContain("Signed in as dana@example.com.");
    const form = forms(markup)[0];
    expect(form.names).toEqual(["consent", "consent_version", "org"]);
    expect(markup).toContain('action="/api/integrations/jira/connect"');
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "consent_version", value: CONSENT_VERSIONS.jira }));
  });

  it("says why the connect route sent the person back", async () => {
    memberships.value = [workspace("acme")];
    expect(text(await connectPage({ error: "forbidden" }))).toContain("Only an owner or admin of a workspace connects Jira to it.");
    expect(text(await connectPage({ error: "not_set_up" }))).toContain("Jira is not set up on this deployment yet.");
    expect(text(await connectPage({ error: "expired" }))).toContain("The time to choose a Jira site ran out. Start again.");
    expect(text(await connectPage({ consent: "missing" }))).toContain("Tick I agree to connect Jira.");
  });

  it("tells a person who manages no workspace's integrations who can connect it", async () => {
    memberships.value = [workspace("acme", "approver")];
    const words = text(await connectPage());
    expect(words).toContain("Only an owner or admin connects Jira");
    expect(words).toContain("Ask an owner or admin of your workspace to connect Jira, or sign in with the account that is one.");
    expect(words).not.toContain("Continue to Jira");
  });

  it("offers the sites Atlassian listed as real radio buttons, posting the pick to the choose route (JR2)", async () => {
    memberships.value = [workspace("acme")];
    pending.value = {
      id: CHOICE,
      provider: "jira",
      choices: [
        { externalOrgId: "5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c", name: "Northstar", connectionId: null },
        { externalOrgId: "6f5e4d3c-2b1a-4098-8e7d-6c5b4a3f2e1d", name: "Northstar Labs", connectionId: null },
      ],
      consent: { version: CONSENT_VERSIONS.jira, at: "2026-11-09T08:00:00.000Z" },
      scopes: [],
      chooseUntil: "2026-11-09T08:10:00.000Z",
    };
    const markup = await connectPage({ org: "acme", choose: CHOICE });
    const words = text(markup);
    expect(markup).toMatch(/<h1[^>]*>[^]*?lucide-square-kanban[^]*?Choose the Jira site to connect[^]*?<\/h1>/);
    expect(words).toContain("Atlassian gave access to more than one Jira site.");
    expect(words).toContain("Vestiarion reads only the one you choose.");
    expect(markup).toContain('action="/api/integrations/jira/choose"');
    const radios = inputs(markup).filter((input) => input.type === "radio");
    expect(radios.map((radio) => radio.value)).toEqual(["5e4d3c2b-1a09-4f8e-9d7c-6b5a4f3e2d1c", "6f5e4d3c-2b1a-4098-8e7d-6c5b4a3f2e1d"]);
    expect(radios.map((radio) => labelFor(markup, radio.id))).toEqual(["Northstar", "Northstar Labs"]);
    expect(radios.every((radio) => radio.name === "organisation" && "required" in radio)).toBe(true);
    expect(markup).toMatch(/<legend[^>]*>Site<\/legend>/);
    expect(forms(markup)).toEqual([{ names: ["choice", "org", "organisation", "organisation"], buttons: ["Connect this site"] }]);
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "choice", value: CHOICE }));
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "org", value: "acme" }));
    expect(text(await connectPage({ org: "acme", choose: CHOICE, error: "pick" }))).toContain("Choose one of the sites Atlassian listed.");
  });

  it("says the time to choose ran out when the pending grant is gone, or is another tool's, and starts again", async () => {
    memberships.value = [workspace("acme")];
    const gone = await connectPage({ org: "acme", choose: CHOICE });
    expect(text(gone)).toContain("The time to choose a Jira site ran out");
    expect(text(gone)).toContain("Start again: Atlassian asks you once more which site to connect.");
    expect(gone).toMatch(/<a[^>]*href="\/integrations\/jira\/connect\?org=acme"[^>]*>Connect Jira<\/a>/);
    expect(gone).not.toContain("/api/integrations/jira/choose");
    pending.value = { id: CHOICE, provider: "xero", choices: [{ externalOrgId: "tenant-1", name: "Demo Company", connectionId: null }], consent: null, scopes: [], chooseUntil: "2026-11-09T08:10:00.000Z" };
    expect(text(await connectPage({ org: "acme", choose: CHOICE }))).toContain("The time to choose a Jira site ran out");
  });

  it("says Jira is not set up where it is not configured, with no form (JR1)", async () => {
    jiraOn.value = false;
    memberships.value = [workspace("acme")];
    const markup = await connectPage({ org: "acme" });
    expect(text(markup)).toContain("Jira is not set up on this deployment yet.");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("/api/integrations/jira/");
  });
});
