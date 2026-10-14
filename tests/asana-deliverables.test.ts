import { describe, expect, it } from "vitest";
import { deliverablesFrom, deliverablesOf, fingerprintOf, linksIn, MAX_DELIVERABLES } from "@/lib/asana/deliverables";
import type { AttachmentFacts, CommentFacts } from "@/lib/asana/map";
import { attachmentGidOf, taskRefOf } from "@/lib/asana/urls";

/**
 * What a task delivers, and its fingerprint (docs/superpowers/specs/2026-10-14-asana-acceptance-design.md A6, A10): the
 * description's links, the attachments and the comments' links, in one order whatever Asana answered; an attachment
 * added, removed or uploaded again, or a link changed, is a deliverable that changed. And an Asana link read for its ids
 * alone (A4, A13).
 */

const TASK_URL = "https://app.asana.com/0/1219477646404725/1219477646404728";
const attachment = (gid: string, fields: Partial<AttachmentFacts> = {}): AttachmentFacts => ({
  gid,
  name: `logo-${gid}.mp4`,
  host: "asana",
  createdAt: "2026-10-14T08:00:00.000Z",
  href: `https://app.asana.com/app/asana/-/get_asset?asset_id=${gid}`,
  ...fields,
});
const comment = (text: string, gid = "9001"): CommentFacts => ({ gid, text, createdAt: "2026-10-14T08:30:00.000Z" });
const NOTES = "Acceptance: a 5-second logo animation, MP4 and GIF.\nDeliverable: https://www.figma.com/file/AbC123/logo-motion.\nTask: " + TASK_URL;

describe("links in a text", () => {
  it("are https only, each once, without the punctuation after them", () => {
    expect(linksIn("See https://drive.google.com/x/y, and (https://example.com/a). http://plain.example/no and https://drive.google.com/x/y again.")).toEqual([
      "https://drive.google.com/x/y",
      "https://example.com/a",
    ]);
    expect(linksIn("no links here")).toEqual([]);
    expect(linksIn("javascript:alert(1) https://user:pw@example.com/a")).toEqual([]);
  });
});

describe("a task's deliverables", () => {
  it("are its attachments, the description's links and the comments' links, never the task's own page", () => {
    const { deliverables, more } = deliverablesOf({ notes: NOTES, attachments: [attachment("301")], comments: [comment("v2 here: https://www.figma.com/file/AbC123/logo-motion-v2")], taskUrl: TASK_URL });
    expect(more).toBe(0);
    expect(deliverables.map((item) => [item.kind, item.label])).toEqual([
      ["attachment", "logo-301.mp4"],
      ["link", "figma.com/file/AbC123/logo-motion"],
      ["comment_link", "figma.com/file/AbC123/logo-motion-v2"],
    ]);
  });

  it("have one fingerprint whatever order Asana answered in, and whatever an attachment is called", () => {
    const one = deliverablesOf({ notes: NOTES, attachments: [attachment("301"), attachment("302")], comments: [], taskUrl: TASK_URL });
    const other = deliverablesOf({ notes: NOTES, attachments: [attachment("302", { name: "renamed.mp4" }), attachment("301")], comments: [], taskUrl: TASK_URL });
    expect(fingerprintOf(one.deliverables)).toBe(fingerprintOf(other.deliverables));
    expect(fingerprintOf(one.deliverables)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("change their fingerprint when an attachment is added, removed or uploaded again, or a link changes", () => {
    const base = fingerprintOf(deliverablesOf({ notes: NOTES, attachments: [attachment("301")], comments: [], taskUrl: TASK_URL }).deliverables);
    const changed = [
      deliverablesOf({ notes: NOTES, attachments: [attachment("301"), attachment("302")], comments: [], taskUrl: TASK_URL }),
      deliverablesOf({ notes: NOTES, attachments: [], comments: [], taskUrl: TASK_URL }),
      deliverablesOf({ notes: NOTES, attachments: [attachment("301", { createdAt: "2026-10-15T08:00:00.000Z" })], comments: [], taskUrl: TASK_URL }),
      deliverablesOf({ notes: NOTES.replace("logo-motion", "logo-motion-final"), attachments: [attachment("301")], comments: [], taskUrl: TASK_URL }),
      deliverablesOf({ notes: NOTES, attachments: [attachment("301")], comments: [comment("new cut: https://vimeo.com/1234")], taskUrl: TASK_URL }),
    ];
    for (const read of changed) expect(fingerprintOf(read.deliverables)).not.toBe(base);
    // A link moved from the description to a comment is the same deliverable.
    const moved = deliverablesOf({ notes: "Acceptance only.", attachments: [attachment("301")], comments: [comment("https://www.figma.com/file/AbC123/logo-motion")], taskUrl: TASK_URL });
    expect(fingerprintOf(moved.deliverables)).toBe(base);
  });

  it("keep at most 50, and count the rest in the fingerprint", () => {
    const many = Array.from({ length: MAX_DELIVERABLES + 3 }, (_, index) => attachment(String(1000 + index)));
    const read = deliverablesOf({ notes: "", attachments: many, comments: [], taskUrl: null });
    expect(read.deliverables).toHaveLength(MAX_DELIVERABLES);
    expect(read.more).toBe(3);
    expect(fingerprintOf(read.deliverables, read.more)).not.toBe(fingerprintOf(read.deliverables, 0));
  });

  it("read back from a row, leaving out what does not read and any link that is not https", () => {
    expect(
      deliverablesFrom([
        { kind: "attachment", id: "301", label: "logo.mp4", href: "https://app.asana.com/app/asana/-/get_asset?asset_id=301", version: "2026-10-14T08:00:00.000Z" },
        { kind: "link", id: "x", label: "x", href: "javascript:alert(1)" },
        { kind: "other", id: "y", label: "y" },
        "nothing",
      ])
    ).toEqual([
      { kind: "attachment", id: "301", label: "logo.mp4", href: "https://app.asana.com/app/asana/-/get_asset?asset_id=301", version: "2026-10-14T08:00:00.000Z" },
      { kind: "link", id: "x", label: "x", href: null },
    ]);
  });
});

describe("an Asana link", () => {
  it("names its task in every form Asana uses", () => {
    expect(taskRefOf("https://app.asana.com/0/1219477646404725/1219477646404728")).toEqual({ taskGid: "1219477646404728", projectGid: "1219477646404725", workspaceGid: null });
    expect(taskRefOf("https://app.asana.com/0/1219477646404725/1219477646404728/f")).toMatchObject({ taskGid: "1219477646404728" });
    expect(taskRefOf("https://app.asana.com/0/0/1219477646404730")).toEqual({ taskGid: "1219477646404730", projectGid: null, workspaceGid: null });
    expect(taskRefOf("https://app.asana.com/1/1204081671801519/project/1219477646404725/task/1219477646404730?focus=true")).toEqual({
      taskGid: "1219477646404730",
      projectGid: "1219477646404725",
      workspaceGid: "1204081671801519",
    });
    expect(taskRefOf("https://app.asana.com/1/1204081671801519/task/1219477646404730")).toMatchObject({ taskGid: "1219477646404730", projectGid: null });
  });

  it("names nothing on another host, scheme or port, or without a task", () => {
    for (const raw of [
      "http://app.asana.com/0/1/2",
      "https://app.asana.com.evil.example/0/1/2",
      "https://evil.example/0/1/2",
      "https://app.asana.com:8443/0/1/2",
      "https://user@app.asana.com/0/1/2",
      "https://app.asana.com/0/1219477646404725/list",
      "https://app.asana.com/1/1204081671801519/project/1219477646404725/list",
      "not a link",
    ]) {
      expect(taskRefOf(raw), raw).toBeNull();
    }
  });

  it("names an attachment by its permanent link only", () => {
    expect(attachmentGidOf("https://app.asana.com/app/asana/-/get_asset?asset_id=1219477646404801")).toBe("1219477646404801");
    expect(attachmentGidOf("https://app.asana.com/app/asana/-/get_asset?asset_id=../x")).toBeNull();
    expect(attachmentGidOf("https://app.asana.com/0/1/2")).toBeNull();
  });
});
