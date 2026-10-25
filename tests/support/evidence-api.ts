import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { AuthenticatedKey } from "@/lib/platform/api-keys";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./fake-supabase";

/**
 * What the tests of the evidence reads share (docs/superpowers/specs/2026-10-25-sdk-0-4-evidence-receipts-close-pack-
 * design.md): a key's workspace, a key of its own per test so each starts with a full brake (EA6), the routes driven as
 * the API serves them, and what counts as a write (EA8).
 */

export const API_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0a";
export const OTHER_ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0b";
export const WORKSPACE = { slug: "northstar-studio", name: "Northstar Studio" };
export const API_KEY = `vxk_abcdefgh_${"A".repeat(43)}`;

export const apiConfig = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});

let issued = 0;
/** A read key of its own, so a test's evidence reads come out of a bucket nothing else has spent. */
export function readKey(orgId = API_ORG): AuthenticatedKey {
  issued += 1;
  return { keyId: `5e5e5e5e-0000-4000-8000-${String(issued).padStart(12, "0")}`, orgId, scopes: ["read"], createdBy: null };
}

/** The workspace's row, as the scope and `workspaceInScope` read it. */
export const ORG_ROW = {
  id: API_ORG,
  slug: WORKSPACE.slug,
  name: WORKSPACE.name,
  mode: "live",
  network: "arc-testnet",
  ledger_signing_key_enc: null,
  circle_api_key_enc: null,
  circle_entity_secret_enc: null,
};

/** A fake database whose `orgs` answers the key's workspace, and every other table as `respond` says (none: empty). */
export function apiWorld(respond: (request: RecordedRequest) => FakeReply | Promise<FakeReply> = () => ({ body: [] })) {
  return fakeSupabase((request) => (request.path === "/rest/v1/orgs" ? { body: ORG_ROW } : respond(request)));
}

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response>;

/** One request to a v1 route, with a key, in the platform's context: the guard and `handleApiRequest` do the rest. */
export function callRoute<P>(world: ReturnType<typeof apiWorld>, handler: Handler<P>, url: string, params: P): Promise<Response> {
  const request = new Request(`https://vestiarion.invalid${url}`, { headers: { authorization: `Bearer ${API_KEY}` } });
  return runWith({ config: apiConfig, db: world.client, fetch: world.fetch }, () => handler(request, { params: Promise.resolve(params) }));
}

/** The read functions a read calls with POST, as PostgREST takes a function's arguments. */
const READ_FUNCTIONS = new Set(["/rest/v1/rpc/ledger_entries_for_targets", "/rest/v1/rpc/org_members"]);

/** Every request that would write: a PATCH, a DELETE, or a POST that is not one of the read functions (EA8). */
export function writesIn(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.method === "PATCH" || request.method === "DELETE" || request.method === "PUT" || (request.method === "POST" && !READ_FUNCTIONS.has(request.path)))
    .map((request) => `${request.method} ${request.path}`);
}

/** Whether a request is the workspace's own: its org named by a filter or an argument, or its row read by id. */
export function inWorkspace(request: RecordedRequest, orgId = API_ORG): boolean {
  if (request.path === "/rest/v1/orgs") return request.params.get("id") === `eq.${orgId}`;
  if (request.path.startsWith("/rest/v1/rpc/")) return (request.body as Record<string, unknown> | undefined)?.p_org_id === orgId;
  return request.params.get("org_id") === `eq.${orgId}`;
}
