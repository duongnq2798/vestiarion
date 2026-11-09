import { describe, expect, it } from "vitest";
import { BOOKS_PAYMENTS, PICKS_PAYMENT_ACCOUNT } from "@/lib/connectors/booking";
import { ConnectRefusal } from "@/lib/connectors/connect-refusal";
import { CONSENT_HISTORY, CONSENT_VERSIONS, consentStatement, namesModelProvider } from "@/lib/connectors/consent";
import { PROVIDER_KINDS, PROVIDER_LABELS, PROVIDER_WORDS, providerKind, PROVIDERS, providerWords, UNMARKED_PROVIDERS } from "@/lib/connectors/provider";
import { connectionStatus, syncErrorWords, type ConnectionFacts } from "@/lib/connectors/status";
import { actionLabel } from "@/lib/usage/model";

/**
 * Jira on the connector core (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR1, JR2, JR3, JR22): a work
 * tool, as Linear is, on one Jira site, that books nothing and brings no bills or deals in; its words for a site and its
 * linked issues; the reconnect words that name the Atlassian account and the 90 days; its statement; and `no_site`, the
 * refusal of a grant that reaches no Jira site.
 */

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
