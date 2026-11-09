import { describe, expect, it } from "vitest";
import { ADF_DEPTH, ADF_NODES, adfLinksIn, DELIVERABLES_BYTES, deliverablesOf, fingerprintOf, MAX_DELIVERABLES, storedBytes } from "@/lib/jira/deliverables";
import { CANCELED_RESOLUTIONS, cancels, commentsTruncated, jiraDate, mapIssue, type AttachmentFacts, type CommentFacts, type RemoteLinkFacts } from "@/lib/jira/map";
import { issueRefOf, linksToIssue, siteHost } from "@/lib/jira/urls";

/**
 * Accepting work delivered in Jira, by the rules alone (docs/superpowers/specs/2026-11-09-jira-acceptance-design.md JR6,
 * JR8, JR9, JR13): what a pasted link or key is read as, the links an Atlassian Document Format text holds, what an issue
 * delivers and its fingerprint, and what an issue's answer says of whether it is done, canceled, and when. Pure: no
 * Jira, no database.
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
