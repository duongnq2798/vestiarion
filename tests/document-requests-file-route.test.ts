import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase } from "./support/fake-supabase";

/**
 * Opening the document a vendor sent (docs/superpowers/specs/2026-10-23-document-requests-design.md ER6): for members of
 * its workspace only, by a one-minute address from the private storage; refused cross-site, without a session, to anyone
 * else, and for a request with no file.
 */

const { ORG, USER, REQUEST } = vi.hoisted(() => ({
  ORG: "0b6c1c9e-4a4f-4a7e-9b1e-000000000c1c",
  USER: "63a43a55-78f9-4b85-907a-eea1483a06c1",
  REQUEST: "2b6c1c9e-4a4f-4a7e-9b1e-0000000000c3",
}));
const { sessionMock, membershipMock, storage } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  membershipMock: vi.fn(),
  storage: { uploadUrl: vi.fn(), download: vi.fn(), move: vi.fn(), remove: vi.fn(), openUrl: vi.fn() },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionUser: sessionMock }));
vi.mock("@/lib/auth/membership", () => ({ membershipFor: membershipMock }));
vi.mock("@/lib/dal", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/dal")>()), platformStorage: () => storage }));

import { GET } from "@/app/api/document-requests/[id]/file/route";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MEMBERSHIP = { orgId: ORG, slug: "pinecrest", name: "Pinecrest Studio", mode: "live" as const, role: "viewer" as const };

function open(file: Record<string, unknown> | null, headers: Record<string, string> = {}) {
  const fake = fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: { id: ORG, slug: "pinecrest", name: "Pinecrest Studio", mode: "live", ledger_signing_key_enc: null, circle_api_key_enc: null, circle_entity_secret_enc: null } };
    if (request.path === "/rest/v1/document_requests") return { body: file };
    return { body: [] };
  });
  const response = runWith({ config, db: fake.client, fetch: fake.fetch }, () =>
    GET(new Request(`https://www.vestiarion.xyz/api/document-requests/${REQUEST}/file?org=pinecrest`, { headers }), { params: Promise.resolve({ id: REQUEST }) })
  );
  return { fake, response };
}

const ANSWERED = { id: REQUEST, status: "answered", file_path: `${ORG}/document-requests/${REQUEST}/${"a".repeat(64)}`, file_type: "application/pdf" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  sessionMock.mockResolvedValue({ id: USER, email: "viewer@pinecrest.example" });
  membershipMock.mockResolvedValue(MEMBERSHIP);
  storage.openUrl.mockResolvedValue({ data: { signedUrl: "https://tests.supabase.invalid/storage/v1/object/sign/documents/x?token=s&download=document.pdf" }, error: null });
});

describe("opening a vendor's document (ER6)", () => {
  it("sends any member of the workspace on to a one-minute address that downloads it, and keeps no copy or referrer", async () => {
    const { fake, response } = open(ANSWERED);
    const answer = await response;
    expect(answer.status).toBe(303);
    expect(answer.headers.get("location")).toBe("https://tests.supabase.invalid/storage/v1/object/sign/documents/x?token=s&download=document.pdf");
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
    expect(storage.openUrl).toHaveBeenCalledWith(ANSWERED.file_path, 60, `document-${REQUEST}.pdf`);
    expect(membershipMock).toHaveBeenCalledWith(USER, "pinecrest");
    const read = fake.requests.find((request) => request.path === "/rest/v1/document_requests")!;
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(read.params.get("id")).toBe(`eq.${REQUEST}`);
  });

  it("refuses a cross-site request, a person signed out, and anyone not a member, before reading anything", async () => {
    expect((await open(ANSWERED, { "sec-fetch-site": "cross-site" }).response).status).toBe(403);
    sessionMock.mockResolvedValueOnce(null);
    expect((await open(ANSWERED).response).status).toBe(401);
    membershipMock.mockResolvedValueOnce(null);
    const stranger = open(ANSWERED);
    expect((await stranger.response).status).toBe(404);
    expect(stranger.fake.requests.some((request) => request.path === "/rest/v1/document_requests")).toBe(false);
    expect(storage.openUrl).not.toHaveBeenCalled();
  });

  it("finds nothing for a request with no file, or of another workspace", async () => {
    expect((await open({ id: REQUEST, status: "open", file_path: null, file_type: null }).response).status).toBe(404);
    expect((await open(null).response).status).toBe(404);
    expect(storage.openUrl).not.toHaveBeenCalled();
  });
});
