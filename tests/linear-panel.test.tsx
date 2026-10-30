import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgMembership } from "@/lib/auth/membership";

const { memberships, actions } = vi.hoisted(() => ({
  memberships: { value: [] as OrgMembership[] },
  actions: {
    disconnectLinearAction: vi.fn(),
    syncLinearNowAction: vi.fn(),
    linkLinearIssueAction: vi.fn(),
    unlinkLinearIssueAction: vi.fn(),
    setLinearCriteriaAction: vi.fn(),
    acceptLinearWorkAction: vi.fn(),
    checkLinearIssueAction: vi.fn(),
  },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/linear", () => actions);
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
vi.mock("@/lib/linear/settings", async (original) => ({ ...(await original<typeof import("@/lib/linear/settings")>()), linearSettingsFromEnv: () => ({}) }));
vi.mock("@/components/vx/SiteChrome", () => ({ SiteHeader: () => null, SiteFooter: () => null }));

import LinearIntegrationPage from "@/app/integrations/linear/page";
import LinearPanel, { LINEAR_NOTICES } from "@/components/LinearPanel";
import { LinearIssueCard } from "@/components/LinearIssueCard";
import { LINK_ACCEPTED, LINK_HELD, LINK_READY, MEMBER_EMAILS, RETRIES_CRITERIA } from "@/app/docs-shots/linear-fixture";
import type { IssueLink } from "@/lib/linear/links";
import { linearMilestoneView, type LinearPanelView } from "@/lib/linear/views";
import { workToolCards } from "@/lib/work-tool-cards";

/**
 * Linear's Settings card, a milestone's Linear card on Contractors and the launch page
 * (docs/superpowers/specs/2026-10-31-linear-acceptance-design.md LN2, LN4, LN5, LN8, LN15, LN16), as Asana's: each state
 * in words, the controls for whoever may use them, each form posting the fields its server action reads, and Linear's
 * name beside the product's icon for work tools, never a logo. And which work tool's card a milestone offers.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const buttons = (markup: string) => [...markup.matchAll(/<(?:button|a)\b[^>]*>([^]*?)<\/(?:button|a)>/g)].map((match) => text(match[1]).trim()).filter(Boolean);
/** Every `<input>`'s attributes. */
const inputs = (markup: string): Array<Record<string, string>> =>
  [...markup.matchAll(/<input\b([^>]*)>/g)].map((match) => Object.fromEntries([...match[1].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((attribute) => [attribute[1], attribute[2] ?? ""])));
/** The forms of a markup, each as its inputs' names and its buttons' words. */
const forms = (markup: string) =>
  [...markup.matchAll(/<form\b[^>]*>([^]*?)<\/form>/g)].map((match) => ({
    names: [...inputs(match[1]), ...[...match[1].matchAll(/<textarea\b([^>]*)>/g)].map((area) => ({ name: area[1].match(/name="([^"]*)"/)?.[1] ?? "" }))].map((input) => input.name).sort(),
    buttons: buttons(match[1]),
  }));

const card = (view: LinearPanelView, canManage = true, notice: string | null = null) =>
  renderToStaticMarkup(<LinearPanel orgSlug="acme" view={view} canManage={canManage} notice={notice} />);

const connected = (fields: Partial<Extract<LinearPanelView, { state: "connection" }>> = {}): LinearPanelView => ({
  state: "connection",
  status: { tone: "ok", title: "Connected to the Northstar workspace in Linear", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  workspaceName: "Northstar",
  counts: { linked: 3, ready: 1, accepted: 1, held: 1 },
  figures: { manualChecks: 3, disputes: 1, timeToProposal: "2 minutes", window: "the last 30 days" },
  ...fields,
});

beforeEach(() => {
  memberships.value = [];
});

describe("the Linear card in Settings (Linear acceptance LN2, LN15, LN16)", () => {
  it("is headed Linear in words beside the icon for work tools, with the guide, and no logo", () => {
    const markup = card({ state: "not_connected" });
    expect(markup).toContain('id="linear"');
    expect(markup).toContain('aria-labelledby="linear-title"');
    expect(markup).toMatch(/id="linear-title"[^>]*>[^]*?lucide-square-kanban[^]*?Linear/);
    expect(markup).toContain('href="/docs/guides/linear"');
    expect(markup).not.toContain("/brands/");
  });

  it("says when it is not set up, with no button", () => {
    const markup = card({ state: "not_set_up" });
    expect(text(markup)).toContain("Linear is not set up on this deployment yet.");
    expect(markup).not.toContain("/integrations/linear/connect");
  });

  it("offers Connect Linear to an owner or admin, naming the workspace, and says who connects it to others", () => {
    const markup = card({ state: "not_connected" });
    expect(text(markup)).toContain("Pay contractors for work delivered in Linear.");
    expect(text(markup)).toContain("An issue marked done alone never pays");
    expect(markup).toMatch(/<a[^>]*href="\/integrations\/linear\/connect\?org=acme"[^>]*>[^]*?Connect Linear/);
    const other = card({ state: "not_connected" }, false);
    expect(text(other)).toContain("An owner or admin connects Linear.");
    expect(other).not.toContain("/integrations/linear/connect");
  });

  it("counts the linked issues by where they stand, linking to Contractors, and shows the last 30 days' figures", () => {
    const words = text(card(connected()));
    expect(words).toContain("Connected to the Northstar workspace in Linear");
    expect(words).toContain("3 issues linked to milestones");
    expect(words).toContain("1 issue ready for acceptance");
    expect(words).toContain("1 issue held for review");
    expect(words).toContain("In the last 30 days");
    expect(words).toContain("Evidence checked by a person 3 acceptances");
    expect(words).toContain("Disputes 1 acceptance taken back");
    expect(words).toContain("From acceptance to the agent's decision 2 minutes");
    expect(card(connected())).toMatch(/<a[^>]*href="\/o\/acme\/contractors"[^>]*>3 issues linked to milestones<\/a>/);
    expect(text(card(connected({ counts: { linked: 0, ready: 0, accepted: 0, held: 0 }, figures: { manualChecks: 0, disputes: 0, timeToProposal: null, window: "the last 30 days" } })))).toContain(
      "No milestone is linked to a Linear issue yet."
    );
  });

  it("gives an owner or admin Check linked issues now and Disconnect Linear, each posting the workspace, and others neither", () => {
    const markup = card(connected());
    expect(buttons(markup)).toEqual(expect.arrayContaining(["Check linked issues now", "Disconnect Linear"]));
    for (const form of forms(markup)) expect(form.names).toEqual(["orgSlug"]);
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "orgSlug", value: "acme" }));
    const other = card(connected(), false);
    expect(buttons(other)).not.toContain("Disconnect Linear");
    expect(buttons(other)).not.toContain("Check linked issues now");
    expect(text(other)).toContain("An owner or admin manages Linear.");
  });

  it("offers Reconnect Linear when Linear no longer accepts the connection, and Connect Linear once disconnected", () => {
    const reconnect = card(connected({ connected: false, status: { tone: "error", title: "Linear needs you to reconnect", detail: [], reconnect: true } }));
    expect(reconnect).toMatch(/<a[^>]*href="\/integrations\/linear\/connect\?org=acme"[^>]*>[^]*?Reconnect Linear/);
    expect(buttons(reconnect)).not.toContain("Check linked issues now");
    const revoked = card(connected({ connected: false, revoked: true, status: { tone: "off", title: "Disconnected from the Northstar workspace in Linear", detail: [], reconnect: false } }));
    expect(revoked).toMatch(/<a[^>]*href="\/integrations\/linear\/connect\?org=acme"[^>]*>[^]*?Connect Linear/);
    expect(buttons(revoked)).not.toContain("Disconnect Linear");
    expect(text(revoked)).not.toContain("linked to milestones");
  });

  it("says how connecting went, for every way back the connect flow has for Linear", () => {
    // The core's ways back (src/lib/connectors/connect.ts). Linear is not exclusive, so never other_workspace; it writes
    // nothing, so never writing or write_not_granted; and its provider refuses no grant of its own.
    expect(Object.keys(LINEAR_NOTICES).sort()).toEqual(["cancelled", "connected", "failed", "forbidden", "not_set_up", "other_organisation"]);
    expect(text(card({ state: "not_connected" }, true, "connected"))).toContain("Linear is connected. Link a milestone to its Linear issue on Contractors.");
    expect(card({ state: "not_connected" }, true, "cancelled")).toMatch(/<p role="status" class="text-sm text-refused">Connecting Linear was cancelled. Nothing changed.<\/p>/);
    expect(text(card({ state: "not_connected" }, true, "other_organisation"))).toContain("This workspace is connected to another Linear workspace.");
    expect(text(card({ state: "not_connected" }, true, "unknown"))).not.toContain("Linear is connected.");
  });
});

const view = (link: IssueLink | null, fields: { status?: string; criteria?: string | null; connected?: boolean; canWrite?: boolean } = {}) =>
  linearMilestoneView({
    milestone: { id: "m-1", status: fields.status ?? "pending", acceptance_criteria: fields.criteria === undefined ? RETRIES_CRITERIA : fields.criteria },
    link,
    connected: fields.connected ?? true,
    canWrite: fields.canWrite ?? true,
    links: null,
    memberEmails: MEMBER_EMAILS,
  });
const issueCard = (milestoneView: ReturnType<typeof view>) => renderToStaticMarkup(<LinearIssueCard orgSlug="acme" milestoneId="m-1" view={milestoneView} />);

describe("a milestone's Linear card on Contractors (Linear acceptance LN4, LN5, LN8, LN16)", () => {
  it("links an issue by its link or its ID, posting `issue`, and takes the criteria from the agreement", () => {
    const markup = issueCard(view(null, { criteria: null }));
    expect(markup).toContain('data-linear-state="unlinked"');
    expect(text(markup)).toContain("Accept from Linear");
    expect(text(markup)).toContain("Paste the issue's link or its ID. Vestiarion reads the issue through Linear with this workspace's connection, never by opening the link.");
    const [link, criteria] = forms(markup);
    expect(link).toEqual({ names: ["issue", "milestoneId", "orgSlug"], buttons: ["Link the issue"] });
    expect(criteria).toEqual({ names: ["criteria", "milestoneId", "orgSlug"], buttons: ["Add the criteria"] });
    // A text field, so an ID like ENG-123 is taken as well as a link.
    expect(inputs(markup).find((input) => input.name === "issue")).toMatchObject({ type: "text", required: "" });
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "milestoneId", value: "m-1" }));
  });

  it("asks to connect Linear when it is not connected, and shows nothing to whoever may not verify milestones", () => {
    expect(text(issueCard(view(null, { connected: false })))).toContain("Connect Linear in Settings, Integrations, to accept this work from a Linear issue.");
    expect(forms(issueCard(view(null, { connected: false })))).toEqual([]);
    expect(issueCard(view(null, { canWrite: false }))).toBe("");
  });

  it("offers Accept the work on a done issue with criteria, posting the fingerprint and the criteria's hash shown (LN8)", () => {
    const shown = view(LINK_READY);
    const markup = issueCard(shown);
    expect(markup).toContain('data-linear-state="ready"');
    expect(text(markup)).toContain("Linear issue ENG-142: Webhook retries with backoff");
    expect(markup).toMatch(/<a href="https:\/\/linear\.app\/northstar\/issue\/ENG-142\/webhook-retries-with-backoff" target="_blank" rel="noreferrer"/);
    expect(text(markup)).toContain("Deliverables in Linear");
    expect(text(markup)).toContain("Attachment: Retry failed webhook deliveries with backoff #318");
    expect(text(markup)).toContain("Link in the description: uploads.linear.app/");
    expect(text(markup)).toContain("Link in a comment: docs-preview.northstar.example/webhooks/retries");
    expect(text(markup)).toContain("I checked each criterion against these deliverables, as shown here.");
    expect(text(markup)).toContain("nothing from Linear sets the amount or the payee.");
    const accept = forms(markup).find((form) => form.buttons.includes("Accept the work"));
    expect(accept?.names).toEqual(["confirmed", "criteriaSha256", "fingerprint", "milestoneId", "orgSlug"]);
    expect(inputs(markup).find((input) => input.name === "confirmed")).toMatchObject({ value: "yes" });
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "fingerprint", value: LINK_READY.fingerprint as string }));
    expect(inputs(markup)).toContainEqual(expect.objectContaining({ type: "hidden", name: "criteriaSha256", value: shown.linked ? (shown.criteriaSha256 as string) : "" }));
    expect(buttons(markup)).toEqual(expect.arrayContaining(["Check Linear now", "Unlink the issue"]));
  });

  it("offers no acceptance without criteria, and holds the issue for them", () => {
    const markup = issueCard(view({ ...LINK_READY, state: "held", heldReason: "no_criteria" }, { criteria: null }));
    expect(buttons(markup)).not.toContain("Accept the work");
    expect(text(markup)).toContain("The issue is done, but the milestone has no acceptance criteria.");
    expect(buttons(markup)).toContain("Add the criteria");
  });

  it("shows an accepted issue's deliverables as accepted, who accepted them, and its criteria fixed", () => {
    const markup = issueCard(view(LINK_ACCEPTED, { status: "verified" }));
    expect(markup).toContain('data-linear-state="accepted"');
    expect(text(markup)).toContain("Deliverables accepted");
    expect(text(markup)).toContain("Accepted on Oct 31, 2026 by adam@northstar.example.");
    expect(buttons(markup)).not.toContain("Accept the work");
    expect(buttons(markup)).not.toContain("Save the criteria");
    expect(text(markup)).toContain("Acceptance criteria Failed webhook deliveries are retried 5 times");
  });

  it("holds a reopened issue for review, and lets a person accept it again only once it is done again (LN10)", () => {
    const markup = issueCard(view(LINK_HELD));
    expect(markup).toContain('data-linear-state="held"');
    expect(text(markup)).toContain("Held for review");
    expect(text(markup)).toContain("The issue was reopened in Linear after the work was accepted");
    expect(buttons(markup)).not.toContain("Accept the work");
    const doneAgain = issueCard(view({ ...LINK_HELD, completed: true, completedAt: "2026-10-31T11:00:00.000Z", stateType: "completed", stateName: "Done" }));
    expect(buttons(doneAgain)).toContain("Accept the work");
  });

  it("shows a linked issue without controls to whoever may not verify milestones", () => {
    const markup = issueCard(view(LINK_READY, { canWrite: false }));
    expect(text(markup)).toContain("Ready for acceptance");
    expect(forms(markup)).toEqual([]);
  });

  it("says an acceptance is taken back by unlinking the issue, and only on an accepted issue (LN10)", () => {
    const words = "To take the acceptance back, unlink the issue: the milestone then waits for verification again.";
    expect(text(issueCard(view(LINK_ACCEPTED, { status: "verified" })))).toContain(words);
    expect(text(issueCard(view(LINK_READY)))).not.toContain(words);
    expect(text(issueCard(view(LINK_ACCEPTED, { status: "verified", canWrite: false })))).not.toContain(words);
  });

  it("leaves the criteria to Asana's card when both offer to link the milestone, so they are asked once", () => {
    const markup = renderToStaticMarkup(<LinearIssueCard orgSlug="acme" milestoneId="m-1" view={view(null)} withCriteria={false} />);
    expect(forms(markup)).toEqual([{ names: ["issue", "milestoneId", "orgSlug"], buttons: ["Link the issue"] }]);
    expect(markup).not.toContain("Acceptance criteria, from the agreement");
    expect(text(markup)).toContain("The acceptance criteria are the milestone's, written once under Accept from Asana: the work is held to them in Linear too.");
    // A linked issue keeps its own criteria field until the work is accepted.
    const linked = renderToStaticMarkup(<LinearIssueCard orgSlug="acme" milestoneId="m-1" view={view({ ...LINK_READY, state: "held", heldReason: "no_criteria" }, { criteria: null })} withCriteria={false} />);
    expect(buttons(linked)).toContain("Add the criteria");
  });
});

describe("which work tool's card a milestone offers (Linear acceptance LN4, LN16)", () => {
  const tool = (connected: boolean, linked = false) => ({ connected, linked });

  it("leaves Asana's card as it was where Linear is not configured", () => {
    for (const connected of [true, false]) {
      expect(workToolCards({ pending: true, asana: tool(connected), linear: null })).toEqual({ asana: true, linear: false, linearCriteria: false });
      expect(workToolCards({ pending: false, asana: tool(connected), linear: null })).toEqual({ asana: false, linear: false, linearCriteria: false });
      expect(workToolCards({ pending: false, asana: tool(connected, true), linear: null })).toEqual({ asana: true, linear: false, linearCriteria: false });
    }
  });

  it("offers no card for linking a milestone in one tool once it is linked in the other", () => {
    expect(workToolCards({ pending: true, asana: tool(true), linear: tool(true, true) })).toEqual({ asana: false, linear: true, linearCriteria: true });
    expect(workToolCards({ pending: true, asana: tool(true, true), linear: tool(true) })).toEqual({ asana: true, linear: false, linearCriteria: false });
  });

  it("offers an open milestone the connected tool's card, both when both are connected, and both when neither is", () => {
    expect(workToolCards({ pending: true, asana: tool(false), linear: tool(true) })).toEqual({ asana: false, linear: true, linearCriteria: true });
    expect(workToolCards({ pending: true, asana: tool(true), linear: tool(false) })).toEqual({ asana: true, linear: false, linearCriteria: false });
    // Both connected: Asana's card asks for the criteria, and Linear's leaves them to it.
    expect(workToolCards({ pending: true, asana: tool(true), linear: tool(true) })).toEqual({ asana: true, linear: true, linearCriteria: false });
    expect(workToolCards({ pending: true, asana: tool(false), linear: tool(false) })).toEqual({ asana: true, linear: true, linearCriteria: true });
  });

  it("keeps a linked card on a milestone no longer open, as its history, and offers none to link one", () => {
    expect(workToolCards({ pending: false, asana: tool(true), linear: tool(true, true) })).toEqual({ asana: false, linear: true, linearCriteria: true });
    expect(workToolCards({ pending: false, asana: tool(true), linear: tool(true) })).toEqual({ asana: false, linear: false, linearCriteria: false });
  });
});

describe("the Linear launch page (Linear acceptance LN2)", () => {
  const workspace = (slug: string): OrgMembership => ({ orgId: `org-${slug}`, slug, name: slug === "acme" ? "Acme Studio" : "Beta Works", mode: "live", role: "owner", network: "arc-testnet" });

  it("takes a person with one workspace straight to its Linear card", async () => {
    memberships.value = [workspace("acme")];
    await expect(LinearIntegrationPage()).rejects.toThrow("redirect /o/acme/settings#linear");
  });

  it("lets a person with several workspaces pick one, headed by Linear's name beside the icon for work tools", async () => {
    memberships.value = [workspace("acme"), workspace("beta")];
    const markup = renderToStaticMarkup(await LinearIntegrationPage());
    expect(markup).toMatch(/<h1[^>]*>[^]*?lucide-square-kanban[^]*?Linear<\/h1>/);
    expect(markup).not.toContain("/brands/");
    expect(markup).toContain('href="/o/acme/settings#linear"');
    expect(markup).toContain('href="/o/beta/settings#linear"');
    expect(text(markup)).toContain("Pick the workspace whose Linear settings you want.");
  });
});
