import crypto from "node:crypto";
import { membershipFor } from "../auth/membership";
import { isValidSlug } from "../auth/org-paths";
import { can } from "../auth/roles";
import { getSessionUser } from "../auth/session";
import { platformDb } from "../dal";
import { withOrg } from "../dal/scope";
import { masterKeysFromEnv, type MasterKey } from "../secrets";
import { ConnectRefusal } from "./connect-refusal";
import { connectedElsewhere, connectionFor, NotSetUpError, saveConnection, type Connection } from "./connections";
import { CONSENT_VERSIONS } from "./consent";
import type { ConnectingProvider, ExternalOrganisation, ProviderTokens } from "./provider";
import { connectState, newNonce, readConnectState, STATE_TTL_MS, type Consent } from "./state";
import { attachPending, pendingChoice, saveTokens } from "./token-store";

/**
 * Connecting a workspace to an accounting provider (docs/superpowers/specs/2026-10-12-xero-connector-design.md X3, X4,
 * X12), for any provider: the person picks the workspace and agrees on the connect page, which posts here; they go to
 * the provider with a signed state whose nonce is also in an HttpOnly cookie; on the way back the state, the cookie,
 * the person, their membership and role, and their consent are all checked again before the code is exchanged. The
 * consent recorded is the version the page showed, posted with the form; a page older than the current words is
 * refused and shown again (`?consent=changed`). One organisation is connected at once; several are offered on the
 * connect page, the tokens kept as a pending grant for ten minutes. Every way back lands on Settings
 * (`?<provider>=<outcome>#<provider>`) or the connect page.
 */

export interface ConnectDeps {
  provider: ConnectingProvider;
  /**
   * Throws `NotSetUpError` when the provider's own tables are not in this database yet (a CRM's `crm_deals`, migration
   * 0105; HubSpot connector H4), so no one is sent to the provider for nothing.
   */
  ready?: () => Promise<void>;
  /** The deployment's own origin: where the provider sends people back, and the only origin a form may post from. */
  origin: string;
  keys?: MasterKey[];
  now?: () => number;
  /** Runs the first sync once the answer is sent (`after()` in the route); a test passes its own. */
  afterConnect?: (work: () => Promise<void>) => void;
  /** The first sync itself, in the workspace's scope. */
  firstSync?: (connection: Connection) => Promise<unknown>;
  /**
   * A provider that writes only once a person allows it (a CRM's receipts, docs/superpowers/specs/2026-10-13-crm-receipts-design.md
   * R3): the connect page offers it, and once the provider answered with the scopes it granted, this turns writing on
   * (`writing`) or says it was not granted (`write_not_granted`), in the workspace's scope. Without it, the connect page's
   * choice is ignored.
   */
  allowWrites?: (input: { connection: Connection; userId: string; scopes: readonly string[] }) => Promise<"writing" | "write_not_granted" | "write_not_set_up">;
}

const cookieName = (deps: ConnectDeps) => `vx_${deps.provider.id}_oauth`;
const redirectUri = (deps: ConnectDeps) => `${deps.origin}/api/integrations/${deps.provider.id}/callback`;
const connectPage = (deps: ConnectDeps, query: Record<string, string>) =>
  `${deps.origin}/integrations/${deps.provider.id}/connect?${new URLSearchParams(query).toString()}`;
/** Signing in first, then back to the connect page with the workspace still picked (a slug, never anything else). */
const signIn = (deps: ConnectDeps, slug: string) =>
  `${deps.origin}/login?next=${encodeURIComponent(`/integrations/${deps.provider.id}/connect${isValidSlug(slug) ? `?org=${slug}` : ""}`)}`;
const settingsUrl = (deps: ConnectDeps, slug: string, outcome: string) =>
  `${deps.origin}/o/${slug}/settings?${deps.provider.id}=${outcome}#${deps.provider.id}`;

function redirect(url: string, cookie?: string, status = 303): Response {
  return new Response(null, { status, headers: { location: url, ...(cookie ? { "set-cookie": cookie } : {}) } });
}

function cookie(deps: ConnectDeps, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${cookieName(deps)}=${value}; Path=/api/integrations/${deps.provider.id}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function cookieValue(header: string | null, name: string): string | null {
  for (const part of (header ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function sameNonce(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** A form posted from this deployment's own pages, never from another site. */
function sameOrigin(request: Request, deps: ConnectDeps): boolean {
  return request.headers.get("origin") === deps.origin;
}

const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

const expired = (label: string) =>
  new Response(`This ${label} connection link has expired or was not started from this browser. Start again from Settings in Vestiarion.`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

/** The person signed in, a member of the workspace who may manage its integrations; null otherwise. */
async function manager(slug: string, userId: string) {
  const membership = await membershipFor(userId, slug);
  return membership && can(membership.role, "integrations.manage") ? membership : null;
}

/** `POST /api/integrations/<provider>/connect`: from the connect page's form, to the provider. */
export async function startConnect(request: Request, deps: ConnectDeps): Promise<Response> {
  if (!sameOrigin(request, deps)) return Response.json({ error: "forbidden" }, { status: 403 });
  const form = await request.formData();
  const slug = text(form, "org");
  const user = await getSessionUser();
  if (!user) return redirect(signIn(deps, slug));
  if (!isValidSlug(slug)) return redirect(connectPage(deps, { error: "forbidden" }));
  const membership = await manager(slug, user.id);
  if (!membership) return redirect(connectPage(deps, { org: slug, error: "forbidden" }));
  if (text(form, "consent") !== "yes") return redirect(connectPage(deps, { org: slug, consent: "missing" }));
  // Allowing writes is the person's own choice on the connect page, offered only by a provider that writes on it.
  const write = deps.allowWrites !== undefined && text(form, "write") === "yes";
  // The version is the one the page showed: words changed since it loaded are shown again, never agreed to unread.
  const version = CONSENT_VERSIONS[deps.provider.id];
  if (text(form, "consent_version") !== version) {
    return redirect(connectPage(deps, { org: slug, consent: "changed", ...(write ? { write: "1" } : {}) }));
  }
  try {
    await withOrg(
      membership.orgId,
      async () => {
        await connectionFor(deps.provider.id);
        await deps.ready?.();
      },
      { userId: user.id }
    );
  } catch (error) {
    if (error instanceof NotSetUpError) return redirect(connectPage(deps, { org: slug, error: "not_set_up" }));
    throw error;
  }

  const now = (deps.now ?? Date.now)();
  const nonce = newNonce();
  const consent: Consent = { version, at: new Date(now).toISOString() };
  const state = connectState({ provider: deps.provider.id, org: membership.orgId, user: user.id, nonce, consent, write }, deps.keys ?? masterKeysFromEnv(), now);
  return redirect(deps.provider.authorizeUrl({ state, redirectUri: redirectUri(deps), write }), cookie(deps, nonce, STATE_TTL_MS / 1000));
}

/** Connects one organisation in the workspace's scope, keeps its tokens, and starts its first sync after the answer. */
async function connectOne(
  deps: ConnectDeps,
  input: { orgId: string; userId: string; organisation: ExternalOrganisation; scopes: string[]; consent: Consent; write?: boolean } & (
    | { tokens: ProviderTokens }
    | { pendingId: string }
  )
): Promise<"connected" | "writing" | "write_not_granted" | "write_not_set_up" | "other_organisation" | "other_workspace" | "expired"> {
  // One workspace per organisation, for a provider whose disconnect ends every grant (QuickBooks Q5) or whose account two
  // workspaces must not share (HubSpot H4). The tokens just granted are neither kept nor revoked: revoking them would cut
  // the other workspace off too.
  if (deps.provider.exclusive && (await connectedElsewhere(deps.provider.id, input.organisation.externalOrgId, input.orgId))) return "other_workspace";
  const saved = await saveConnection({
    provider: deps.provider.id,
    organisation: input.organisation,
    connectedBy: input.userId,
    scopes: input.scopes,
    consent: input.consent,
    nowMs: (deps.now ?? Date.now)(),
  });
  if (!saved.ok) return saved.reason;
  if ("tokens" in input) {
    await saveTokens({ orgId: input.orgId, provider: deps.provider.id, connectionId: saved.connection.id, authorizedBy: input.userId, tokens: input.tokens }, deps.keys);
  } else if (!(await attachPending(input.orgId, input.pendingId, saved.connection.id, (deps.now ?? Date.now)()))) {
    return "expired";
  }
  const { firstSync, afterConnect } = deps;
  // Writing allowed on the connect page is turned on before the first sync, so that sync writes the receipts too.
  const written = "tokens" in input && input.write && deps.allowWrites ? await deps.allowWrites({ connection: saved.connection, userId: input.userId, scopes: input.scopes }) : null;
  if (firstSync && afterConnect) {
    afterConnect(() =>
      withOrg(input.orgId, async () => {
        await firstSync(saved.connection);
      }, { userId: input.userId }).catch((error: unknown) => {
        console.error("connector: the first sync failed", saved.connection.id, error instanceof Error ? error.message : "unknown error");
      })
    );
  }
  return written ?? "connected";
}

/** `GET /api/integrations/<provider>/callback`: where the provider sends the person back. */
export async function finishConnect(request: Request, deps: ConnectDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // An install started at the provider, from its app marketplace, comes back with no state of ours (Pipedrive's
  // installation flows): nothing is exchanged. The person picks the workspace and agrees on the connect page first,
  // then the provider is asked again; one who cancelled there lands on the same page, to start when they choose.
  if (!params.has("state")) return redirect(connectPage(deps, params.get("error") ? {} : { installed: "1" }), undefined, 302);
  const keys = deps.keys ?? masterKeysFromEnv();
  const now = (deps.now ?? Date.now)();
  const state = readConnectState(params.get("state") ?? "", keys, now);
  const nonce = cookieValue(request.headers.get("cookie"), cookieName(deps));
  if (!state || state.provider !== deps.provider.id || !nonce || !sameNonce(nonce, state.nonce)) return expired(deps.provider.label);
  const org = await platformDb().from("orgs").select("slug").eq("id", state.org).maybeSingle<{ slug: string }>();
  if (org.error) throw new Error(org.error.message);
  const slug = org.data?.slug;
  if (!slug) return expired(deps.provider.label);

  // The state is used: whatever happens next, its cookie goes.
  const spent = cookie(deps, "", 0);
  const back = (outcome: string) => redirect(settingsUrl(deps, slug, outcome), spent, 302);
  const user = await getSessionUser();
  if (!user || user.id !== state.user) return back("forbidden");
  const membership = await manager(slug, user.id);
  if (!membership || membership.orgId !== state.org) return back("forbidden");
  if (!state.consent) return redirect(connectPage(deps, { org: slug, consent: "missing" }), spent, 302);
  const code = params.get("code");
  if (params.get("error") || !code) return back("cancelled");
  // A provider whose callback names the one organisation of the grant (QuickBooks' realmId, Q4): read only now, after
  // every check, and confirmed by the provider with the new token before anything is kept.
  const namedParam = deps.provider.callbackOrganisationParam;
  const named = namedParam ? params.get(namedParam) : null;
  if (namedParam && !named) return back("failed");

  const exchanged = await deps.provider.exchangeCode({ code, redirectUri: redirectUri(deps) });
  if (!exchanged.ok) return back("failed");
  const consent = state.consent;
  try {
    return await withOrg(
      state.org,
      async () => {
        const organisations = named
          ? await deps.provider.organisations(exchanged.tokens, exchanged.authEventId, named)
          : await deps.provider.organisations(exchanged.tokens, exchanged.authEventId);
        if (organisations.length === 1) {
          return back(
            await connectOne(deps, {
              orgId: state.org,
              userId: user.id,
              organisation: organisations[0],
              scopes: exchanged.tokens.scopes,
              consent,
              tokens: exchanged.tokens,
              write: state.write === true,
            })
          );
        }
        const pendingId = await saveTokens(
          {
            orgId: state.org,
            provider: deps.provider.id,
            connectionId: null,
            authorizedBy: user.id,
            tokens: exchanged.tokens,
            pending: { choices: organisations, chooseUntil: new Date(now + STATE_TTL_MS).toISOString(), consent },
          },
          keys
        );
        return redirect(connectPage(deps, { org: slug, choose: pendingId }), spent, 302);
      },
      { userId: user.id }
    );
  } catch (error) {
    if (error instanceof NotSetUpError) return back("not_set_up");
    // A grant the provider's own rules say cannot be connected (Pipedrive connector P4): its words on the card.
    if (error instanceof ConnectRefusal) return back(error.outcome);
    // The message names the call and a status, never a token.
    console.error("connector: connecting failed", deps.provider.id, error instanceof Error ? error.message : "unknown error");
    return back("failed");
  }
}

/** `POST /api/integrations/<provider>/choose`: the organisation picked among several. */
export async function chooseConnect(request: Request, deps: ConnectDeps): Promise<Response> {
  if (!sameOrigin(request, deps)) return Response.json({ error: "forbidden" }, { status: 403 });
  const form = await request.formData();
  const slug = text(form, "org");
  const pendingId = text(form, "choice");
  const externalOrgId = text(form, "organisation");
  const user = await getSessionUser();
  if (!user) return redirect(signIn(deps, slug));
  if (!isValidSlug(slug)) return redirect(connectPage(deps, { error: "forbidden" }));
  const membership = await manager(slug, user.id);
  if (!membership) return redirect(connectPage(deps, { org: slug, error: "forbidden" }));
  if (!/^[0-9a-f-]{36}$/.test(pendingId)) return redirect(connectPage(deps, { org: slug, error: "expired" }));
  try {
    return await withOrg(
      membership.orgId,
      async () => {
        const pending = await pendingChoice(membership.orgId, pendingId, user.id, (deps.now ?? Date.now)());
        if (!pending || pending.provider !== deps.provider.id || !pending.consent) return redirect(connectPage(deps, { org: slug, error: "expired" }));
        const organisation = pending.choices.find((choice) => choice.externalOrgId === externalOrgId);
        if (!organisation) return redirect(connectPage(deps, { org: slug, choose: pendingId, error: "pick" }));
        const outcome = await connectOne(deps, {
          orgId: membership.orgId,
          userId: user.id,
          organisation,
          scopes: pending.scopes,
          consent: pending.consent,
          pendingId,
        });
        return outcome === "expired" ? redirect(connectPage(deps, { org: slug, error: "expired" })) : redirect(settingsUrl(deps, slug, outcome));
      },
      { userId: user.id }
    );
  } catch (error) {
    if (error instanceof NotSetUpError) return redirect(settingsUrl(deps, slug, "not_set_up"));
    console.error("connector: choosing an organisation failed", deps.provider.id, error instanceof Error ? error.message : "unknown error");
    return redirect(settingsUrl(deps, slug, "failed"));
  }
}
