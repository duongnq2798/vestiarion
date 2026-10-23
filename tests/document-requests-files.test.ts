import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The files a workspace's document requests hold in the private storage (document requests ER5), as deleting the
 * workspace removes them: every row named, in pages, since PostgREST answers at most 1000 rows a request; and, once
 * the rows are gone, everything left under the workspace's own folder, which no row may name any more.
 */

const { storage } = vi.hoisted(() => ({
  storage: { uploadUrl: vi.fn(), download: vi.fn(), move: vi.fn(), remove: vi.fn(), openUrl: vi.fn(), list: vi.fn() },
}));
vi.mock("@/lib/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dal")>()), platformStorage: () => storage }));

import { documentFilesOf, removeWorkspaceDocumentFiles } from "@/lib/document-requests/read";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f2f";
const ROOT = `${ORG}/document-requests`;
const SHA = (letter: string) => letter.repeat(64);

/** PostgREST over `rows`, as the paged read asks it: ordered by id, after the last id seen, at most `limit` (and 1000). */
function requestsTable(rows: Array<{ id: string; file_path: string | null }>) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path !== "/rest/v1/document_requests") return { body: [] };
    const after = request.params.get("id")?.replace(/^gt\./, "") ?? "";
    const limit = Math.min(Number(request.params.get("limit") ?? "1000"), 1000);
    return { body: [...rows].sort((a, b) => a.id.localeCompare(b.id)).filter((row) => row.id > after).slice(0, limit) };
  });
}

const within = <T,>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), fn);

/** Storage's list over a tree of folders: an entry with no id is a folder, as Supabase answers. */
function storageTree(tree: Record<string, Array<{ name: string; id: string | null }>>) {
  storage.list.mockImplementation(async (folder: string, page: { limit: number; offset: number }) => ({
    data: (tree[folder] ?? []).slice(page.offset, page.offset + page.limit),
    error: null,
  }));
}

beforeEach(() => {
  storage.list.mockReset().mockResolvedValue({ data: [], error: null });
  storage.remove.mockReset().mockResolvedValue({ data: [], error: null });
});

describe("documentFilesOf", () => {
  it("names the files of every request, read in pages of 1000 by id, since one request answers at most 1000 rows", async () => {
    const rows = Array.from({ length: 1001 }, (_, n) => ({ id: `r-${String(n).padStart(4, "0")}`, file_path: n === 1000 ? `${ROOT}/r-1000/${SHA("a")}` : null }));
    const fake = requestsTable(rows);

    const files = await within(fake, () => documentFilesOf(ORG));

    expect(files).toHaveLength(1002);
    expect(files).toContain(`${ROOT}/r-0000/upload`);
    expect(files).toContain(`${ROOT}/r-1000/upload`);
    expect(files).toContain(`${ROOT}/r-1000/${SHA("a")}`);
    const reads = fake.requests.filter((request) => request.path === "/rest/v1/document_requests");
    expect(reads).toHaveLength(2);
    expect(reads.map((request) => [request.params.get("order"), request.params.get("limit"), request.params.get("id")])).toEqual([
      ["id.asc", "1000", null],
      ["id.asc", "1000", "gt.r-0999"],
    ]);
  });

  it("keeps to the counterparties named, on every page", async () => {
    const fake = requestsTable([{ id: "r-1", file_path: null }]);

    expect(await within(fake, () => documentFilesOf(ORG, ["cp-0", "cp-1"]))).toEqual([`${ROOT}/r-1/upload`]);
    expect(fake.requests[0].params.get("counterparty_id")).toBe("in.(cp-0,cp-1)");
  });
});

describe("removeWorkspaceDocumentFiles", () => {
  it("removes what the rows named and every file left under the workspace's folder, which no row names any more", async () => {
    // r-1's answer failed after its file was kept, and the file could not be removed then; r-2 was answered after the
    // rows were read; r-3's upload was never sent.
    storageTree({
      [ROOT]: [
        { name: "r-1", id: null },
        { name: "r-2", id: null },
        { name: "r-3", id: null },
      ],
      [`${ROOT}/r-1`]: [{ name: SHA("a"), id: "o-1" }],
      [`${ROOT}/r-2`]: [{ name: SHA("b"), id: "o-2" }, { name: "upload", id: "o-3" }],
      [`${ROOT}/r-3`]: [{ name: "upload", id: "o-4" }],
    });

    await within(requestsTable([]), () => removeWorkspaceDocumentFiles(ORG, [`${ROOT}/r-2/upload`, `${ROOT}/r-3/upload`]));

    expect(storage.list).toHaveBeenCalledWith(ROOT, { limit: 100, offset: 0 });
    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove.mock.calls[0][0]).toEqual([`${ROOT}/r-2/upload`, `${ROOT}/r-3/upload`, `${ROOT}/r-1/${SHA("a")}`, `${ROOT}/r-2/${SHA("b")}`]);
  });

  it("lists every page of a folder, and removes 100 files a call", async () => {
    const folders = Array.from({ length: 150 }, (_, n) => ({ name: `r-${String(n).padStart(3, "0")}`, id: null }));
    storageTree({
      [ROOT]: folders,
      ...Object.fromEntries(folders.map((folder) => [`${ROOT}/${folder.name}`, [{ name: SHA("c"), id: `o-${folder.name}` }]])),
    });

    await within(requestsTable([]), () => removeWorkspaceDocumentFiles(ORG, []));

    expect(storage.list).toHaveBeenCalledWith(ROOT, { limit: 100, offset: 100 });
    const removed = storage.remove.mock.calls.map((call) => call[0] as string[]);
    expect(removed.map((paths) => paths.length)).toEqual([100, 50]);
    expect(new Set(removed.flat())).toEqual(new Set(folders.map((folder) => `${ROOT}/${folder.name}/${SHA("c")}`)));
  });

  it("still removes what the rows named when the folder cannot be listed, and never throws", async () => {
    storage.list.mockResolvedValue({ data: null, error: { message: "storage unavailable" } });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await within(requestsTable([]), () => removeWorkspaceDocumentFiles(ORG, [`${ROOT}/r-1/upload`]));

    expect(storage.remove.mock.calls.map((call) => call[0])).toEqual([[`${ROOT}/r-1/upload`]]);
    expect(logged).toHaveBeenCalledWith("document files not listed", ROOT, "storage unavailable");

    storage.list.mockRejectedValue(new Error("network"));
    await expect(within(requestsTable([]), () => removeWorkspaceDocumentFiles(ORG, []))).resolves.toBeUndefined();
    logged.mockRestore();
  });
});
