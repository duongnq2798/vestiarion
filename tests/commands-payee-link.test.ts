import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { issuePayeeLink } from "@/lib/commands/payee-links";
import { PayeeLinkError } from "@/lib/platform/payee-links";
import { publicOrigin } from "@/lib/public-origin";
import { carriesOrg, fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Making a payee link, as one command for every surface (write API part 2, W3, W4): the gate first, then the payee
 * looked up in the workspace in scope (a client is never paid, so it gets no link), then the link made as the actor's,
 * with the surface named in its entry. The link's address is given back once. The library itself is
 * tests/payee-links.test.ts's; here it is a stand-in.
 */

const { createMock } = vi.hoisted(() => ({ createMock: vi.fn() }));
vi.mock("@/lib/platform/payee-links", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/payee-links")>()),
  createPayeeLink: createMock,
}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const PAYEE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const KEY_ID = "3c3c3c3c-0000-4000-8000-000000000001";
const TOKEN = `vxp_${"A".repeat(43)}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const admin = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "admin", mode: "live", surface: { kind: "console" }, ...fields });
const viaApi = admin({ surface: { kind: "api", apiKeyId: KEY_ID } });

function workspace(role: string | null) {
  const fake = fakeSupabase((sent: RecordedRequest) =>
    sent.path === "/rest/v1/counterparties" ? { body: role ? [{ id: PAYEE, role }] : [] } : { body: [] }
  );
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ link: { id: LINK, counterpartyId: PAYEE, expiresAt: "2026-10-10T12:00:00+00:00" }, token: TOKEN });
});

describe("issuePayeeLink", () => {
  it("makes the link as the actor's, for a payee of the workspace in scope, and gives its address back once", async () => {
    const { fake, run } = workspace("contractor");
    expect(await run(() => issuePayeeLink(admin(), { counterpartyId: PAYEE }))).toEqual({
      ok: true,
      message: "Link created. Copy it now: it is shown only once.",
      linkId: LINK,
      counterpartyId: PAYEE,
      url: `${publicOrigin()}/payee/${TOKEN}`,
      expiresAt: "2026-10-10T12:00:00+00:00",
    });
    expect(createMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, counterpartyId: PAYEE });
    const lookup = fake.requests.find((sent) => sent.path === "/rest/v1/counterparties")!;
    expect(lookup.params.get("id")).toBe(`eq.${PAYEE}`);
    expect(carriesOrg(lookup, ORG)).toBe(true);
  });

  it("names the API and the key for a link made through it", async () => {
    const { run } = workspace("vendor");
    expect(await run(() => issuePayeeLink(viaApi, { counterpartyId: PAYEE }))).toMatchObject({ ok: true, linkId: LINK });
    expect(createMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, counterpartyId: PAYEE, provenance: { via: "api", apiKeyId: KEY_ID } });
  });

  it("makes no link for a client, whom the agent never pays", async () => {
    const { run } = workspace("client");
    expect(await run(() => issuePayeeLink(viaApi, { counterpartyId: PAYEE }))).toEqual({
      ok: false,
      code: "client",
      message: "A payee link is for a vendor or a contractor the agent pays.",
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it("answers a payee the workspace does not hold as not found, before or while the link is made", async () => {
    const { run } = workspace(null);
    expect(await run(() => issuePayeeLink(viaApi, { counterpartyId: PAYEE }))).toEqual({ ok: false, code: "counterparty_not_found", message: "Counterparty not found." });
    expect(createMock).not.toHaveBeenCalled();

    const removed = workspace("vendor");
    createMock.mockRejectedValueOnce(new PayeeLinkError("not_found"));
    expect(await removed.run(() => issuePayeeLink(viaApi, { counterpartyId: PAYEE }))).toMatchObject({ ok: false, code: "counterparty_not_found" });
  });

  it.each([
    ["an approver, who may not add records", admin({ role: "approver" }), "forbidden"],
    ["the Telegram bot", admin({ surface: { kind: "telegram", linkId: "l-1" } }), "surface"],
    ["Slack", admin({ surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: 10 } }), "surface"],
  ] as const)("refuses %s before reading anything", async (_label, actor, code) => {
    const { fake, run } = workspace("vendor");
    expect(await run(() => issuePayeeLink(actor, { counterpartyId: PAYEE }))).toMatchObject({ ok: false, code });
    expect(fake.requests).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses with words a person can act on when the link cannot be made, and logs no detail of it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { run } = workspace("vendor");
    createMock.mockRejectedValueOnce(new Error("connection reset"));
    expect(await run(() => issuePayeeLink(admin(), { counterpartyId: PAYEE }))).toEqual({
      ok: false,
      code: "failed",
      message: "That did not work. Try again in a moment.",
    });
    expect(log).toHaveBeenCalledWith("payee link creation failed");
    log.mockRestore();
  });
});
