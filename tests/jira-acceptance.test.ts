import { describe, expect, it } from "vitest";
import {
  ACCEPTED_ACTION,
  acceptable,
  acceptanceKpis,
  HELD_LINES,
  heldReasonOf,
  jiraPlan,
  planJiraRead,
  planRead,
  SELF_WORDS,
  selfAcceptance,
  stateWords,
  WITHDRAWN_ACTION,
  type LinkFacts,
} from "@/lib/jira/acceptance";
import { ADF_DEPTH, ADF_NODES, adfLinksIn, DELIVERABLES_BYTES, deliverablesOf, fingerprintOf, MAX_DELIVERABLES, storedBytes } from "@/lib/jira/deliverables";
import { CANCELED_RESOLUTIONS, cancels, commentsTruncated, jiraDate, mapIssue, type AttachmentFacts, type CommentFacts, type RemoteLinkFacts } from "@/lib/jira/map";
import { issueRefOf, linksToIssue, siteHost } from "@/lib/jira/urls";
import { acceptanceKpis as linearKpis } from "@/lib/linear/acceptance";

/**
 * Accepting work delivered in Jira, by the rules alone (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR6,
 * JR8 to JR13, JR21, JR22): what a pasted link or key is read as, the links an Atlassian Document Format text holds, what an
 * issue delivers and its fingerprint, what an issue's answer says of whether it is done, canceled, and when, what each read
 * does to a link, who may accept, the words of each state, and the card's figures. Pure: no Jira, no database.
 */

const SITE = "https://northstar.atlassian.net";
const CURLY = String.fromCodePoint(0x2019);

describe("an issue's link or key (Jira acceptance JR6)", () => {
  it("takes a browse link, with more path or a query after it, and keeps the host for the site check", () => {
    expect(issueRefOf("https://northstar.atlassian.net/browse/ENG-142")).toEqual({ key: "ENG-142", host: "northstar.atlassian.net" });
    expect(issueRefOf("https://Northstar.Atlassian.net/browse/eng-142?focusedCommentId=10200")).toEqual({ key: "ENG-142", host: "northstar.atlassian.net" });
    expect(issueRefOf("https://northstar.atlassian.net/browse/ENG-142/more")).toEqual({ key: "ENG-142", host: "northstar.atlassian.net" });
    // Any https host is read: whether it is the connected site's is the link's next check (other_site).
    expect(issueRefOf("https://ridge.atlassian.net/browse/OPS-7")).toEqual({ key: "OPS-7", host: "ridge.atlassian.net" });
  });

  it("takes any https Jira page whose query selects an issue, and a path ending in /issues/KEY", () => {
    expect(issueRefOf("https://northstar.atlassian.net/jira/software/projects/ENG/boards/1?selectedIssue=ENG-142")).toEqual({ key: "ENG-142", host: "northstar.atlassian.net" });
    expect(issueRefOf("https://northstar.atlassian.net/jira/software/c/projects/ENG/issues/?jql=project%3DENG&selectedIssue=ENG-9")).toEqual({ key: "ENG-9", host: "northstar.atlassian.net" });
    expect(issueRefOf("https://northstar.atlassian.net/jira/software/projects/ENG/issues/ENG-142")).toEqual({ key: "ENG-142", host: "northstar.atlassian.net" });
    expect(issueRefOf("https://northstar.atlassian.net/jira/core/projects/ENG/issues/ENG-142?filter=allissues")).toEqual({ key: "ENG-142", host: "northstar.atlassian.net" });
    // The issue a page opens comes before one it selects.
    expect(issueRefOf("https://northstar.atlassian.net/browse/ENG-1?selectedIssue=ENG-2")).toEqual({ key: "ENG-1", host: "northstar.atlassian.net" });
  });

  it("takes a key alone, in any case, upper-cased", () => {
    expect(issueRefOf("  ENG-142 ")).toEqual({ key: "ENG-142", host: null });
    expect(issueRefOf("eng-7")).toEqual({ key: "ENG-7", host: null });
    expect(issueRefOf("DATA_2-123456789012345678")).toEqual({ key: "DATA_2-123456789012345678", host: null });
  });

  it("reads nothing else: http, a port, credentials, another page, a malformed key, over 1,000 characters", () => {
    for (const raw of [
      "http://northstar.atlassian.net/browse/ENG-1",
      "https://northstar.atlassian.net:8443/browse/ENG-1",
      "https://me:pw@northstar.atlassian.net/browse/ENG-1",
      "https://northstar.atlassian.net/jira/software/projects/ENG/boards/1",
      "https://northstar.atlassian.net/browse/ENG",
      "https://northstar.atlassian.net/issues/ENG-1/comments",
      "https://northstar.atlassian.net/?selectedIssue=ENG",
      "javascript:alert(1)//browse/ENG-1",
      "ENG123",
      "ENG-",
      "1-123",
      "ENG-1234567890123456789",
      "ENG-1 OR 1=1",
      "",
      `https://northstar.atlassian.net/browse/ENG-1?${"x".repeat(1000)}`,
    ]) {
      expect(issueRefOf(raw), raw.slice(0, 60)).toBeNull();
    }
  });

  it("knows a link to the issue itself on the connected site, which is no deliverable", () => {
    expect(linksToIssue("https://northstar.atlassian.net/browse/ENG-142", "ENG-142", SITE)).toBe(true);
    expect(linksToIssue("https://northstar.atlassian.net/browse/eng-142?focusedCommentId=1", "eng-142", SITE)).toBe(true);
    expect(linksToIssue("https://northstar.atlassian.net/jira/software/projects/ENG/boards/1?selectedIssue=ENG-142", "ENG-142", SITE)).toBe(true);
    expect(linksToIssue("https://northstar.atlassian.net/browse/ENG-143", "ENG-142", SITE)).toBe(false);
    // The same key on another site is another issue.
    expect(linksToIssue("https://ridge.atlassian.net/browse/ENG-142", "ENG-142", SITE)).toBe(false);
    expect(siteHost(SITE)).toBe("northstar.atlassian.net");
    expect(siteHost("not a site")).toBeNull();
  });
});

/** A paragraph of ADF holding these nodes. */
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content: [{ type: "paragraph", content }] });
const text = (value: string, href?: string) => ({ type: "text", text: value, ...(href ? { marks: [{ type: "strong" }, { type: "link", attrs: { href } }] } : {}) });

describe("the links in Atlassian Document Format (JR8)", () => {
  it("are link marks, the three kinds of smart link, and bare https links in text, each once, in the document's order", () => {
    const links = adfLinksIn(
      doc(
        text("Spec: https://www.figma.com/file/AbC123/retries."),
        text("the build", "https://preview.example/eng-142"),
        { type: "inlineCard", attrs: { url: "https://github.com/northstar/api/pull/42" } },
        { type: "blockCard", attrs: { url: "https://docs.example/runbook" } },
        { type: "embedCard", attrs: { url: "https://www.loom.com/share/abc", layout: "wide" } },
        text("again https://www.figma.com/file/AbC123/retries")
      )
    );
    expect(links).toEqual(["https://www.figma.com/file/AbC123/retries", "https://preview.example/eng-142", "https://github.com/northstar/api/pull/42", "https://docs.example/runbook", "https://www.loom.com/share/abc"]);
  });

  it("read linked text for its target alone, and keep nothing that is not https", () => {
    expect(adfLinksIn(doc(text("https://shown.example/words", "https://target.example/real")))).toEqual(["https://target.example/real"]);
    expect(adfLinksIn(doc(text("x", "http://plain.example"), text("y", "javascript:alert(1)"), { type: "inlineCard", attrs: { url: "ftp://files.example" } }, text("mailto:mai@contractor.example")))).toEqual([]);
    expect(adfLinksIn(null)).toEqual([]);
    expect(adfLinksIn("https://a.example plain text, not ADF")).toEqual([]);
    expect(adfLinksIn({ type: "doc", content: "not a list" })).toEqual([]);
  });

  it("stop at 50 levels and 20,000 nodes, whatever the document holds past them", () => {
    expect(ADF_DEPTH).toBe(50);
    expect(ADF_NODES).toBe(20_000);
    const nested = (depth: number, href: string): unknown => (depth === 0 ? text("x", href) : { type: "bulletList", content: [nested(depth - 1, href)] });
    expect(adfLinksIn({ type: "doc", content: [nested(48, "https://deep.example/ok")] })).toEqual(["https://deep.example/ok"]);
    expect(adfLinksIn({ type: "doc", content: [nested(60, "https://deep.example/too-deep")] })).toEqual([]);
    const many = Array.from({ length: 25_000 }, (_, index) => ({ type: "text", text: index === 24_999 ? "https://last.example/z" : "x" }));
    expect(adfLinksIn({ type: "doc", content: [{ type: "paragraph", content: [text("first", "https://first.example/a"), ...many] }] })).toEqual(["https://first.example/a"]);
  });
});

const ATTACHMENTS: AttachmentFacts[] = [{ id: "10100", filename: "retries.pdf", href: `${SITE}/secure/attachment/10100/retries.pdf`, createdAt: "2026-11-09T06:00:00.000Z" }];
const REMOTE: RemoteLinkFacts[] = [{ id: "10300", title: "PR #42", href: "https://github.com/northstar/api/pull/42" }];
const COMMENTS: CommentFacts[] = [{ id: "10200", createdAt: "2026-11-09T07:00:00.000Z", links: ["https://preview.example/eng-142", `${SITE}/browse/ENG-142`] }];
const base = { descriptionLinks: ["https://www.figma.com/file/AbC123/retries", `${SITE}/browse/ENG-142?focusedCommentId=1`], attachments: ATTACHMENTS, remoteLinks: REMOTE, comments: COMMENTS, key: "ENG-142", siteUrl: SITE };

describe("what an issue delivers, and its fingerprint (JR8, JR13)", () => {
  it("is its files and web links, then its description's links, then its comments' links, never the issue itself", () => {
    const { deliverables, more } = deliverablesOf(base);
    expect(deliverables).toEqual([
      { kind: "attachment", id: "file:10100", label: "retries.pdf", href: `${SITE}/secure/attachment/10100/retries.pdf`, version: "2026-11-09T06:00:00.000Z" },
      { kind: "attachment", id: "remotelink:10300", label: "PR #42", href: "https://github.com/northstar/api/pull/42", version: "https://github.com/northstar/api/pull/42" },
      { kind: "link", id: "https://www.figma.com/file/AbC123/retries", label: "figma.com/file/AbC123/retries", href: "https://www.figma.com/file/AbC123/retries" },
      { kind: "comment_link", id: "https://preview.example/eng-142", label: "preview.example/eng-142", href: "https://preview.example/eng-142" },
    ]);
    expect(more).toBe(0);
    // A web link to the issue itself is no deliverable either.
    expect(deliverablesOf({ ...base, remoteLinks: [{ id: "10301", title: "This issue", href: `${SITE}/browse/ENG-142` }] }).deliverables.map((item) => item.id)).not.toContain("remotelink:10301");
  });

  it("keeps 50 of 60 links and counts the other 10, and keeps no more than the bytes a link row holds", () => {
    expect(MAX_DELIVERABLES).toBe(50);
    const sixty = Array.from({ length: 60 }, (_, index) => `https://links.example/${String(index).padStart(2, "0")}`);
    const { deliverables, more } = deliverablesOf({ ...base, attachments: [], remoteLinks: [], comments: [], descriptionLinks: sixty });
    expect(deliverables).toHaveLength(50);
    expect(more).toBe(10);
    expect(deliverables.at(-1)?.id).toBe("https://links.example/49");
    const long = Array.from({ length: 50 }, (_, index) => `https://links.example/${index}/${"x".repeat(470)}`);
    const capped = deliverablesOf({ ...base, attachments: [], remoteLinks: [], comments: [], descriptionLinks: long });
    expect(storedBytes(capped.deliverables)).toBeLessThanOrEqual(DELIVERABLES_BYTES);
    expect(capped.deliverables.length + capped.more).toBe(50);
    expect(capped.more).toBeGreaterThan(0);
  });

  it("does not change when a file or a web link is renamed, or the same link is said again elsewhere", () => {
    const fp = (input: typeof base) => {
      const { deliverables, more } = deliverablesOf(input);
      return fingerprintOf(deliverables, more);
    };
    const first = fp(base);
    expect(fp({ ...base, attachments: [{ ...ATTACHMENTS[0], filename: "retries-final.pdf", href: `${SITE}/secure/attachment/10100/retries-final.pdf` }] })).toBe(first);
    expect(fp({ ...base, remoteLinks: [{ ...REMOTE[0], title: "Merged: PR #42" }] })).toBe(first);
    expect(fp({ ...base, comments: [...COMMENTS, { id: "10201", createdAt: null, links: ["https://preview.example/eng-142"] }] })).toBe(first);
    expect(fp({ ...base, attachments: [...ATTACHMENTS].reverse() })).toBe(first);
  });

  it("changes with a new file, a new version of one, a web link's new address, and a new link in a comment", () => {
    const fp = (input: typeof base) => {
      const { deliverables, more } = deliverablesOf(input);
      return fingerprintOf(deliverables, more);
    };
    const first = fp(base);
    expect(fp({ ...base, attachments: [...ATTACHMENTS, { id: "10101", filename: "notes.txt", href: null, createdAt: null }] })).not.toBe(first);
    expect(fp({ ...base, attachments: [{ ...ATTACHMENTS[0], id: "10102", createdAt: "2026-11-09T07:45:00.000Z" }] })).not.toBe(first);
    expect(fp({ ...base, remoteLinks: [{ ...REMOTE[0], href: "https://github.com/northstar/api/pull/43" }] })).not.toBe(first);
    expect(fp({ ...base, comments: [{ ...COMMENTS[0], links: [...COMMENTS[0].links, "https://preview.example/eng-142-v2"] }] })).not.toBe(first);
  });
});

/** An issue's answer, at a full read's depth unless the fields say otherwise. */
function issue(fields: Record<string, unknown> = {}) {
  return {
    id: "10042",
    key: "ENG-142",
    fields: {
      summary: "Webhook retries with backoff",
      status: { name: "Done", statusCategory: { key: "done", name: "Done" } },
      resolution: { name: "Done" },
      resolutiondate: "2026-11-09T14:20:00.000+0700",
      statuscategorychangedate: "2026-11-09T14:30:00.000+0700",
      updated: "2026-11-09T14:31:00.000+0700",
      project: { id: "10000", key: "ENG" },
      ...fields,
    },
  };
}

describe("done, canceled, and when (JR9)", () => {
  it("is done by the category's key alone, never the status's name, with no resolution, Done or Fixed", () => {
    for (const resolution of [null, { name: "Done" }, { name: "Fixed" }]) {
      expect(mapIssue(issue({ resolution }), null, SITE), JSON.stringify(resolution)).toMatchObject({ statusCategory: "done", completed: true, canceled: false });
    }
    // A status named Done in another category is not done; one named otherwise in the Done category is.
    expect(mapIssue(issue({ status: { name: "Done", statusCategory: { key: "indeterminate" } } }), null, SITE)).toMatchObject({ completed: false, canceled: false, completedAt: null });
    expect(mapIssue(issue({ status: { name: "Shipped", statusCategory: { key: "done" } } }), null, SITE)).toMatchObject({ completed: true, statusName: "Shipped" });
  });

  it("is canceled when the Done category's resolution says it was not done, curly apostrophe or not", () => {
    for (const name of ["Won't Do", `Won${CURLY}t Do`, "Duplicate", "Cancelled", " canceled ", "WON'T FIX", "Cannot Reproduce", "Not a Bug"]) {
      expect(mapIssue(issue({ resolution: { name } }), null, SITE), name).toMatchObject({ completed: false, canceled: true, completedAt: null });
    }
    expect(mapIssue(issue({ resolution: { name: `Won${CURLY}t Do` } }), null, SITE).resolutionName).toBe(`Won${CURLY}t Do`);
    expect(CANCELED_RESOLUTIONS).toEqual(["won't do", "won't fix", "cancelled", "canceled", "duplicate", "declined", "rejected", "cannot reproduce", "incomplete", "obsolete", "abandoned", "not a bug", "invalid"]);
    expect(cancels(null)).toBe(false);
    // A resolution of Won't Do outside Done is neither.
    expect(mapIssue(issue({ status: { name: "In Progress", statusCategory: { key: "indeterminate" } }, resolution: { name: "Won't Do" } }), null, SITE)).toMatchObject({ completed: false, canceled: false });
  });

  it("is waiting in the new and indeterminate categories, and in an unknown one or none", () => {
    for (const category of ["new", "indeterminate", "undefined", "Done", null]) {
      expect(mapIssue(issue({ status: { name: "Open", statusCategory: category === null ? null : { key: category } } }), null, SITE), String(category)).toMatchObject({ completed: false, canceled: false });
    }
  });

  it("was done when its category last changed, else when it was resolved, else at no known time, in UTC", () => {
    expect(mapIssue(issue(), null, SITE).completedAt).toBe("2026-11-09T07:30:00.000Z");
    expect(mapIssue(issue({ statuscategorychangedate: undefined }), null, SITE).completedAt).toBe("2026-11-09T07:20:00.000Z");
    expect(mapIssue(issue({ statuscategorychangedate: null, resolutiondate: null }), null, SITE)).toMatchObject({ completed: true, completedAt: null });
    expect(jiraDate("2026-11-09T14:30:00.000+0700")).toBe("2026-11-09T07:30:00.000Z");
    expect(jiraDate("2026-11-09T01:30:00.123-0530")).toBe("2026-11-09T07:00:00.123Z");
    expect(jiraDate("2026-11-09T07:30:00+00:00")).toBe("2026-11-09T07:30:00.000Z");
    expect(jiraDate("2026-11-09T07:30:00.5Z")).toBe("2026-11-09T07:30:00.500Z");
    for (const value of ["2026-11-09", "yesterday", "2026-11-09T07:30:00", 1_731_137_400_000, null]) expect(jiraDate(value), String(value)).toBeNull();
  });
});

describe("an issue's answer (JR8)", () => {
  it("keeps its key, title, browse link and project, refreshed on every read, and no person field", () => {
    const facts = mapIssue(issue({ assignee: { accountId: "557058:abc", displayName: "Mai Tran" }, creator: { accountId: "x" } }), null, SITE);
    expect(facts).toEqual({
      id: "10042",
      key: "ENG-142",
      title: "Webhook retries with backoff",
      url: `${SITE}/browse/ENG-142`,
      projectId: "10000",
      projectKey: "ENG",
      statusCategory: "done",
      statusName: "Done",
      resolutionName: "Done",
      completed: true,
      canceled: false,
      completedAt: "2026-11-09T07:30:00.000Z",
      updatedAt: "2026-11-09T07:31:00.000Z",
      depth: "status",
      descriptionLinks: [],
      attachments: [],
      remoteLinks: [],
      comments: [],
      moreUnread: false,
      counts: { attachments: 0, remoteLinks: 0, comments: 0 },
    });
    expect(JSON.stringify(facts)).not.toMatch(/accountId|Mai Tran|557058/);
    expect(mapIssue(issue({ summary: "T".repeat(300) }), null, SITE).title).toHaveLength(255);
    expect(mapIssue(issue({ summary: "  " }), null, SITE).title).toBe("Untitled issue (ENG-142)");
    expect(mapIssue(issue({ project: { id: "x", key: "eng" } }), null, SITE)).toMatchObject({ projectId: null, projectKey: null });
    expect(() => mapIssue({ id: "ENG-142", key: "ENG-142", fields: {} }, null, SITE)).toThrow(/no id/);
    expect(() => mapIssue({ id: "10042", key: "eng-142", fields: {} }, null, SITE)).toThrow(/no id/);
  });

  it("reads its files, web links and newest 50 comments in full, in a fixed order, and says when Jira has more", () => {
    const attachment = Array.from({ length: 55 }, (_, index) => ({ id: String(10_100 + 54 - index), filename: `file-${index}.pdf`, created: "2026-11-09T13:00:00.000+0700" }));
    const remote = [
      { id: 10_301, object: { url: "https://github.com/northstar/api/pull/42", title: "PR #42" } },
      { id: 10_300, object: { url: "http://plain.example/x", title: "Plain" } },
      { id: "bad", object: { url: "https://bad.example" } },
    ];
    const comments = Array.from({ length: 60 }, (_, index) => ({
      id: String(10_200 + index),
      created: `2026-11-09T${String(10 + Math.floor(index / 6)).padStart(2, "0")}:${String((index % 6) * 10).padStart(2, "0")}:00.000+0700`,
      body: doc(text(`see https://comments.example/${index}`)),
    }));
    const facts = mapIssue(issue({ description: doc(text("Spec https://spec.example/doc")), attachment, comment: { comments, total: 60, maxResults: 5000 } }), remote, SITE);
    expect(facts.depth).toBe("full");
    expect(facts.descriptionLinks).toEqual(["https://spec.example/doc"]);
    expect(facts.attachments).toHaveLength(50);
    expect(facts.attachments[0]).toEqual({ id: "10100", filename: "file-54.pdf", href: `${SITE}/secure/attachment/10100/file-54.pdf`, createdAt: "2026-11-09T06:00:00.000Z" });
    expect(facts.remoteLinks).toEqual([{ id: "10301", title: "PR #42", href: "https://github.com/northstar/api/pull/42" }]);
    expect(facts.comments).toHaveLength(50);
    expect(facts.comments[0]).toMatchObject({ id: "10259", links: ["https://comments.example/59"] });
    expect(facts.comments.map((comment) => comment.id)).not.toContain("10209");
    expect(facts.moreUnread).toBe(true);
    expect(facts.counts).toEqual({ attachments: 50, remoteLinks: 2, comments: 50 });
    expect(JSON.stringify(facts)).not.toContain("see https");
    // A file's name is encoded in its link; a name that does not read is the file's id.
    expect(mapIssue(issue({ attachment: [{ id: "10100", filename: "Final report #2.pdf" }, { id: "10101" }] }), [], SITE).attachments).toEqual([
      { id: "10100", filename: "Final report #2.pdf", href: `${SITE}/secure/attachment/10100/Final%20report%20%232.pdf`, createdAt: null },
      { id: "10101", filename: "Attachment 10101", href: `${SITE}/secure/attachment/10101/Attachment%2010101`, createdAt: null },
    ]);
    expect(() => mapIssue(issue(), { not: "a list" }, SITE)).toThrow(/remote links/);
  });

  it("reads the newest comments read on their own when the embedded page was cut short", () => {
    const embedded = { comments: [{ id: "10200", created: "2026-11-01T10:00:00.000+0700", body: doc(text("old https://old.example/build")) }], total: 80, maxResults: 1 };
    expect(commentsTruncated(issue({ comment: embedded }))).toBe(true);
    expect(commentsTruncated(issue({ comment: { ...embedded, total: 1 } }))).toBe(false);
    expect(commentsTruncated(issue())).toBe(false);
    const page = { comments: [{ id: "10279", created: "2026-11-09T14:00:00.000+0700", body: doc(text("new https://new.example/build")) }], total: 80 };
    const facts = mapIssue(issue({ comment: embedded }), [], SITE, page);
    expect(facts.comments).toEqual([{ id: "10279", createdAt: "2026-11-09T07:00:00.000Z", links: ["https://new.example/build"] }]);
    expect(facts.moreUnread).toBe(true);
  });
});

const COMPLETED_AT = "2026-11-09T08:30:00.000Z";
const FP = "a".repeat(64);
const linkFacts = (fields: Partial<LinkFacts> = {}): LinkFacts => ({ state: "waiting", heldReason: null, acceptedAt: null, acceptedFingerprint: null, acceptedCompletedAt: null, afterPayment: false, ...fields });
const accepted = linkFacts({ state: "accepted", acceptedAt: "2026-11-09T09:00:00.000Z", acceptedFingerprint: FP, acceptedCompletedAt: COMPLETED_AT });
/** A read as `factsFromRead` builds it from a Jira issue: never archived, since Jira has no such state (JR10). */
const read = (fields: Partial<{ completed: boolean; canceled: boolean; completedAt: string | null; fingerprint: string }> = {}) => ({
  kind: "issue" as const,
  completed: true,
  canceled: false,
  archived: false,
  completedAt: COMPLETED_AT,
  fingerprint: FP,
  ...fields,
});

describe("what a read does to a link (JR10, JR13)", () => {
  it("makes a done issue ready, never accepted, and holds it without criteria, canceled, or gone", () => {
    expect(jiraPlan(planRead(linkFacts(), read(), { criteria: true }))).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: true });
    expect(jiraPlan(planRead(linkFacts({ state: "ready" }), read(), { criteria: true }))).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: false });
    expect(jiraPlan(planRead(linkFacts(), read(), { criteria: false }))).toEqual({ kind: "set", state: "held", heldReason: "no_criteria", becameReady: false });
    expect(jiraPlan(planRead(linkFacts(), read({ completed: false, canceled: true, completedAt: null }), { criteria: true }))).toEqual({ kind: "set", state: "held", heldReason: "canceled", becameReady: false });
    expect(jiraPlan(planRead(linkFacts(), read({ completed: false, completedAt: null }), { criteria: true }))).toEqual({ kind: "set", state: "waiting", heldReason: null, becameReady: false });
    for (const reason of ["not_found", "forbidden"] as const) {
      expect(jiraPlan(planRead(linkFacts(), { kind: "gone", reason }, { criteria: true }))).toEqual({ kind: "set", state: "held", heldReason: "issue_unreachable", becameReady: false });
    }
  });

  it("takes an acceptance back for each of Jira's reasons, and keeps it while the issue is what was accepted", () => {
    expect(jiraPlan(planRead(accepted, read(), { criteria: true }))).toEqual({ kind: "keep" });
    expect(jiraPlan(planRead(accepted, read({ completed: false, completedAt: null }), { criteria: true }))).toEqual({ kind: "withdraw", reason: "reopened" });
    // Done again at another time: Jira's statuscategorychangedate moved, so it is not the completion accepted.
    expect(jiraPlan(planRead(accepted, read({ completedAt: "2026-11-09T10:00:00.000Z" }), { criteria: true }))).toEqual({ kind: "withdraw", reason: "reopened" });
    expect(jiraPlan(planRead(accepted, read({ completed: false, canceled: true, completedAt: null }), { criteria: true }))).toEqual({ kind: "withdraw", reason: "canceled" });
    expect(jiraPlan(planRead(accepted, read({ fingerprint: "b".repeat(64) }), { criteria: true }))).toEqual({ kind: "withdraw", reason: "deliverable_changed" });
    expect(jiraPlan(planRead(accepted, { kind: "gone", reason: "not_found" }, { criteria: true }))).toEqual({ kind: "withdraw", reason: "issue_unreachable" });
  });

  it("keeps a link held after an acceptance held, whatever Jira says now, until a person accepts again", () => {
    for (const reason of ["reopened", "canceled", "deliverable_changed", "issue_unreachable", "unlinked"] as const) {
      const held = { ...accepted, state: "held" as const, heldReason: reason };
      expect(jiraPlan(planRead(held, read(), { criteria: true }))).toEqual({ kind: "set", state: "held", heldReason: reason, becameReady: false });
    }
  });

  it("holds a link Jira no longer shows as unreachable, whatever it was held for, even after an acceptance or a payment", () => {
    const unreachable = { kind: "set", state: "held", heldReason: "issue_unreachable", becameReady: false };
    for (const reason of ["reopened", "canceled", "deliverable_changed", "issue_unreachable", "no_criteria"] as const) {
      const links = [linkFacts({ state: "held", heldReason: reason }), { ...accepted, state: "held" as const, heldReason: reason }, { ...accepted, state: "held" as const, heldReason: reason, afterPayment: true }];
      for (const link of links) {
        for (const gone of ["not_found", "forbidden"] as const) {
          for (const criteria of [true, false]) expect(planJiraRead(link, { kind: "gone", reason: gone }, { criteria })).toEqual(unreachable);
        }
      }
    }
    // Linear's plan alone keeps the old reason, which Accept and the change check would not refuse: the rule is Jira's.
    const changed = { ...accepted, state: "held" as const, heldReason: "deliverable_changed" as const };
    expect(jiraPlan(planRead(changed, { kind: "gone", reason: "not_found" }, { criteria: true }))).toEqual({ kind: "set", state: "held", heldReason: "deliverable_changed", becameReady: false });
    expect(acceptable(changed, { completed: true, archived: false, criteria: true, milestoneStatus: "pending" })).toBe(true);
    expect(acceptable({ ...changed, heldReason: "issue_unreachable" }, { completed: true, archived: false, criteria: true, milestoneStatus: "pending" })).toBe(false);
    // Any other read is Linear's plan: a found issue keeps the hold, an accepted one gone is taken back.
    expect(planJiraRead(changed, read(), { criteria: true })).toEqual({ kind: "set", state: "held", heldReason: "deliverable_changed", becameReady: false });
    expect(planJiraRead(accepted, { kind: "gone", reason: "forbidden" }, { criteria: true })).toEqual({ kind: "withdraw", reason: "issue_unreachable" });
    expect(planJiraRead(linkFacts(), { kind: "gone", reason: "not_found" }, { criteria: true })).toEqual(unreachable);
    expect(planJiraRead(linkFacts(), read(), { criteria: true })).toEqual({ kind: "set", state: "ready", heldReason: null, becameReady: true });
  });

  it("never yields archived: no Jira read says it, and were Linear's plan ever to answer it, it is an issue Jira no longer shows", () => {
    const reads = [read(), read({ completed: false, completedAt: null }), read({ completed: false, canceled: true, completedAt: null }), read({ fingerprint: "b".repeat(64) }), { kind: "gone" as const, reason: "not_found" as const }];
    for (const link of [linkFacts(), linkFacts({ state: "ready" }), accepted]) {
      for (const one of reads) {
        for (const criteria of [true, false]) expect(JSON.stringify(jiraPlan(planRead(link, one, { criteria })))).not.toContain("archived");
      }
    }
    expect(heldReasonOf("archived")).toBe("issue_unreachable");
    expect(heldReasonOf(null)).toBeNull();
    expect(jiraPlan({ kind: "withdraw", reason: "archived" })).toEqual({ kind: "withdraw", reason: "issue_unreachable" });
    expect(jiraPlan({ kind: "set", state: "held", heldReason: "archived", becameReady: false })).toEqual({ kind: "set", state: "held", heldReason: "issue_unreachable", becameReady: false });
  });

  it("lets a person accept only a done issue with criteria on a pending milestone, never one Jira no longer shows", () => {
    const facts = { completed: true, archived: false, criteria: true, milestoneStatus: "pending" };
    expect(acceptable({ state: "ready", afterPayment: false, heldReason: null }, facts)).toBe(true);
    expect(acceptable({ state: "held", afterPayment: false, heldReason: "reopened" }, facts)).toBe(true);
    expect(acceptable({ state: "held", afterPayment: false, heldReason: "issue_unreachable" }, facts)).toBe(false);
    expect(acceptable({ state: "accepted", afterPayment: false, heldReason: null }, facts)).toBe(false);
    expect(acceptable({ state: "held", afterPayment: true, heldReason: "reopened" }, facts)).toBe(false);
    expect(acceptable({ state: "ready", afterPayment: false, heldReason: null }, { ...facts, criteria: false })).toBe(false);
    expect(acceptable({ state: "ready", afterPayment: false, heldReason: null }, { ...facts, milestoneStatus: "verified" })).toBe(false);
  });
});

describe("who may accept (JR12)", () => {
  const none = { memberEmail: "admin@business.example", payeeEmail: "mai@fernhill.example", payeeJiraIds: [] as string[], memberJiraIds: [] as string[] };

  it("refuses the payee by their email in Vestiarion, in any case and spacing", () => {
    expect(selfAcceptance({ ...none, memberEmail: " Mai@Fernhill.example " })).toBe("payee_member");
    expect(SELF_WORDS.payee_member).toBe("You are this milestone's payee, so someone else accepts the work.");
  });

  it("refuses the payee by their Atlassian account, and lets anyone else accept", () => {
    expect(selfAcceptance({ ...none, payeeJiraIds: ["557058:f58131cb"], memberJiraIds: ["557058:f58131cb"] })).toBe("payee_jira");
    expect(SELF_WORDS.payee_jira).toBe("Your Atlassian account is this milestone's payee, so someone else accepts the work.");
    expect(selfAcceptance({ ...none, payeeJiraIds: ["557058:f58131cb"], memberJiraIds: ["5b10ac8d82e05b22cc7d4ef5"] })).toBeNull();
    expect(selfAcceptance(none)).toBeNull();
    expect(selfAcceptance({ ...none, memberEmail: null, payeeEmail: null })).toBeNull();
  });
});

describe("a link's state in words (JR22)", () => {
  it("says each state, Jira's own words for a canceled issue, and a change after payment", () => {
    expect(stateWords("waiting", null, false)).toEqual({ label: "Waiting for the issue", line: "Not done in Jira yet. It is read again when it changes there. Deliverables are read once it is done." });
    expect(stateWords("ready", null, false)).toEqual({
      label: "Ready for acceptance",
      line: "Done in Jira. Check the deliverables against the criteria, then accept the work: the agent decides on pay only after that.",
    });
    expect(stateWords("accepted", null, false).label).toBe("Accepted");
    expect(stateWords("held", "canceled", false, `Won${CURLY}t Do`)).toEqual({
      label: "Held for review",
      line: `Jira resolved the issue as Won${CURLY}t Do, which is not done. Nothing is accepted from it: reopen it, or link another issue.`,
    });
    expect(stateWords("held", "canceled", false).line).toBe(HELD_LINES.canceled);
    expect(stateWords("held", "issue_unreachable", false).line).toBe(
      "Jira no longer shows this issue to the connection: it was deleted or archived, the person who connected Jira lost access to its project, or another Jira site is connected now. Restore it, link another issue, or reconnect Jira."
    );
    expect(stateWords("held", "reopened", true)).toEqual({
      label: "Changed after payment",
      line: "The issue changed in Jira after the payment was sent. Review it with the contractor: Vestiarion does not take a payment back.",
    });
  });

  it("has a line for every held reason, each naming Jira where Linear's names Linear, and none naming Linear", () => {
    expect(Object.keys(HELD_LINES).sort()).toEqual(["canceled", "deliverable_changed", "issue_unreachable", "no_criteria", "reopened", "unlinked"]);
    for (const [reason, line] of Object.entries(HELD_LINES)) {
      expect(line, reason).not.toMatch(/Linear/);
      if (reason !== "no_criteria" && reason !== "unlinked") expect(line, reason).toMatch(/Jira/);
    }
  });
});

describe("the card's figures (JR21)", () => {
  it("count Jira's acceptances and those taken back, never Linear's or Asana's, with the median minutes to the agent's decision", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const kpis = acceptanceKpis(
      [
        { action: ACCEPTED_ACTION, ts: "2026-11-09T10:00:00Z", milestoneId: "m-1" },
        { action: "milestone_release", ts: "2026-11-09T10:04:00Z", milestoneId: "m-1" },
        { action: ACCEPTED_ACTION, ts: "2026-11-08T10:00:00Z", milestoneId: "m-2" },
        { action: "milestone_hold", ts: "2026-11-08T10:10:00Z", milestoneId: "m-2" },
        { action: WITHDRAWN_ACTION, ts: "2026-11-09T11:00:00Z", milestoneId: "m-3" },
        { action: "linear_work_accepted", ts: "2026-11-09T10:00:00Z", milestoneId: "m-linear" },
        { action: "linear_acceptance_withdrawn", ts: "2026-11-09T10:00:00Z", milestoneId: "m-linear" },
        { action: "milestone_accepted", ts: "2026-11-09T10:00:00Z", milestoneId: "m-asana" },
        { action: ACCEPTED_ACTION, ts: "2026-09-01T10:00:00Z", milestoneId: "m-old" },
      ],
      now
    );
    expect(kpis).toEqual({ manualChecks: 2, disputes: 1, medianMinutesToProposal: 7, proposals: 2 });
    expect([ACCEPTED_ACTION, WITHDRAWN_ACTION]).toEqual(["jira_work_accepted", "jira_acceptance_withdrawn"]);
  });

  it("leave Linear's figures as they were: its own two actions, unless a caller names another tool's", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const events = [
      { action: "linear_work_accepted", ts: "2026-11-09T10:00:00Z", milestoneId: "m-1" },
      { action: ACCEPTED_ACTION, ts: "2026-11-09T10:00:00Z", milestoneId: "m-2" },
      { action: ACCEPTED_ACTION, ts: "2026-11-09T10:30:00Z", milestoneId: "m-3" },
    ];
    expect(linearKpis(events, now).manualChecks).toBe(1);
    expect(linearKpis(events, now, 30, { accepted: ACCEPTED_ACTION, withdrawn: WITHDRAWN_ACTION }).manualChecks).toBe(2);
    expect(acceptanceKpis(events, now).manualChecks).toBe(2);
  });
});
