import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddressChangeAnswer } from "@/components/address-change/AddressChangeAnswer";
import { AddressCheckNote } from "@/components/address-change/AddressCheckNote";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { changeCounterpartyAddress, confirmCounterpartyAddress, CounterpartyAddressError } from "@/lib/counterparty-address";
import { withOrg } from "@/lib/dal/scope";
import { payeeLockRefusal } from "@/lib/payee-lock";
import { askContactAboutAddressChange, counterpartyFrozen } from "@/lib/address-change-check";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * Where "Was this you?" meets the address (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC1, AC3,
 * AC5): every change from one address to another asks the payee's contact, by the path it came; a frozen payee's address
 * is confirmed by no one and paid by no approval; and what the page and Counterparties render.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/app/address-change/[token]/actions", () => ({ answerAddressChangeAction: vi.fn() }));
vi.mock("@/app/actions/intake", () => ({ unfreezeCounterpartyAction: vi.fn() }));
vi.mock("@/lib/address-change-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/address-change-check")>();
  return { ...actual, askContactAboutAddressChange: vi.fn(async () => "asked"), counterpartyFrozen: vi.fn(async () => false) };
});

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0x7a2dc41e9b03f6a85d1c27e4b98f0a3c61d5e10d";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const asked = vi.mocked(askContactAboutAddressChange);
const frozen = vi.mocked(counterpartyFrozen);

beforeEach(() => {
  asked.mockClear();
  frozen.mockReset();
  frozen.mockResolvedValue(false);
});

function world(row: Record<string, unknown>, answer: (request: RecordedRequest) => { status?: number; body: unknown } | undefined = () => undefined) {
  const fake = fakeSupabase((request) => {
    const given = answer(request);
    if (given) return given;
    if (request.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG) };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: { id: COUNTERPARTY, name: "Northwind", ...row } };
    if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return { body: [{ id: COUNTERPARTY }] };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn, { userId: USER }));
  return { fake, run };
}

describe("a change asks the payee's contact (AC1)", () => {
  const unconfirmed = { address: OLD, address_changed_at: null, address_confirmed_at: null };

  it("asks on a member's change from one address to another", async () => {
    const { run } = world(unconfirmed);
    await run(() => changeCounterpartyAddress({ actorId: USER, counterpartyId: COUNTERPARTY, raw: NEW }));
    expect(asked).toHaveBeenCalledWith({ orgId: ORG, counterpartyId: COUNTERPARTY, from: OLD, to: NEW, via: "member", githubLogin: null, changedBy: USER });
  });

  it("names a payee link, and GitHub with its login", async () => {
    await world(unconfirmed).run(() => changeCounterpartyAddress({ payeeLinkId: "link-1", counterpartyId: COUNTERPARTY, raw: NEW }));
    expect(asked.mock.calls[0][0]).toMatchObject({ via: "payee_link" });
    await world(unconfirmed).run(() =>
      changeCounterpartyAddress({ github: { installationId: 7, login: "ana", commentUrl: "https://github.com/o/r/pull/1#c" }, counterpartyId: COUNTERPARTY, raw: NEW })
    );
    expect(asked.mock.calls[1][0]).toMatchObject({ via: "github", githubLogin: "ana" });
  });

  it("asks nothing for a cleared address, and leaves a new one after none to the ask, which looks for one cleared before", async () => {
    await world(unconfirmed).run(() => changeCounterpartyAddress({ actorId: USER, counterpartyId: COUNTERPARTY, raw: "" }));
    expect(asked).not.toHaveBeenCalled();
    await world({ ...unconfirmed, address: null }).run(() => changeCounterpartyAddress({ actorId: USER, counterpartyId: COUNTERPARTY, raw: NEW }));
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ from: null, to: NEW }));
  });

  it("asks after the caller's answer when the caller defers it", async () => {
    const deferred: Array<() => Promise<unknown>> = [];
    await world(unconfirmed).run(() => changeCounterpartyAddress({ actorId: USER, counterpartyId: COUNTERPARTY, raw: NEW, defer: (work) => deferred.push(work) }));
    expect(asked).not.toHaveBeenCalled();
    await deferred[0]();
    expect(asked).toHaveBeenCalledTimes(1);
  });
});

describe("a frozen payee (AC3)", () => {
  const waiting = { address: NEW, address_changed_at: "2026-10-22T09:00:00Z", address_confirmed_at: null, chain: null };

  it("has its address confirmed by no one", async () => {
    frozen.mockResolvedValue(true);
    const { fake, run } = world(waiting);
    await expect(run(() => confirmCounterpartyAddress({ actorId: USER, counterpartyId: COUNTERPARTY, shownAddress: NEW, via: "confirm" }))).rejects.toMatchObject({
      code: "frozen",
    });
    expect(fake.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("refuses as frozen when the database refuses a confirmation that raced the freeze", async () => {
    const { run } = world(waiting, (request) =>
      request.path === "/rest/v1/counterparties" && request.method === "PATCH"
        ? { status: 400, body: { code: "P0001", message: "counterparty_frozen: this payee is frozen until an owner or admin unfreezes it" } }
        : undefined
    );
    const confirming = run(() => confirmCounterpartyAddress({ actorId: USER, counterpartyId: COUNTERPARTY, shownAddress: NEW, via: "confirm" }));
    await expect(confirming).rejects.toBeInstanceOf(CounterpartyAddressError);
    await expect(confirming).rejects.toMatchObject({ code: "frozen" });
  });

  it("is paid by no approval, payee lock or not", async () => {
    frozen.mockResolvedValue(true);
    const refusal = await world(waiting).run(() => payeeLockRefusal(COUNTERPARTY, "Northwind"));
    expect(refusal).toBe(
      "Northwind is frozen: their contact on file said they did not make the change to its address. An owner or admin unfreezes it on Counterparties after checking with them."
    );
    frozen.mockResolvedValue(false);
    expect(await world(waiting).run(() => payeeLockRefusal(COUNTERPARTY, "Northwind"))).toBeNull();
  });
});

describe("what the page and Counterparties render (AC3, AC5)", () => {
  const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();

  it("shows the payee both addresses, how it changed, and the two answers, as buttons that submit", () => {
    const markup = renderToStaticMarkup(
      <AddressChangeAnswer
        token="vxw_x"
        change={{ orgName: "Pinecrest Studio", payeeName: "Northwind", from: OLD, to: NEW, via: "payee_link", githubLogin: null, changedAt: "2026-10-22T09:15:00Z" }}
      />
    );
    const words = text(markup);
    expect(words).toContain("Did you change where Pinecrest Studio pays you?");
    expect(words).toContain("was changed through your payment link, on 22 October 2026, 09:15 UTC.");
    expect(words).toContain("0x1111...1111");
    expect(words).toContain(NEW);
    expect(markup).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*name="answer")(?=[^>]*value="me")[^>]*>/);
    expect(markup).toMatch(/<button(?=[^>]*type="submit")(?=[^>]*name="answer")(?=[^>]*value="not_me")[^>]*>/);
    expect(words).toContain("This page never asks for a password, a key or a payment.");
  });

  it("shows a frozen payee with Unfreeze for an owner or admin, and an answer as a line", () => {
    const shown = { orgSlug: "pinecrest", counterparty: { id: COUNTERPARTY, name: "Northwind", address: NEW } };
    const frozenRow = renderToStaticMarkup(<AddressCheckNote {...shown} view={{ frozen: true, check: null }} canUnfreeze />);
    expect(text(frozenRow)).toContain("Northwind is frozen");
    expect(text(frozenRow)).toContain("Unfreeze");
    expect(text(renderToStaticMarkup(<AddressCheckNote {...shown} view={{ frozen: true, check: null }} canUnfreeze={false} />))).not.toContain("Unfreeze");
    const yes = { status: "confirmed" as const, sentAt: "x", expired: false, to: NEW.toUpperCase().replace("0X", "0x") };
    expect(text(renderToStaticMarkup(<AddressCheckNote {...shown} view={{ frozen: false, check: yes }} canUnfreeze />))).toBe("Their billing email said they made this change.");
    // A check about an address no longer on file says nothing of the one that is.
    expect(renderToStaticMarkup(<AddressCheckNote {...shown} view={{ frozen: false, check: { ...yes, to: OLD } }} canUnfreeze />)).toBe("");
    const unanswered = { status: "open" as const, sentAt: "x", expired: true, to: NEW };
    expect(text(renderToStaticMarkup(<AddressCheckNote {...shown} view={{ frozen: false, check: unanswered }} canUnfreeze />))).toBe(
      "Their billing email was asked whether they made this change, and did not answer."
    );
    expect(renderToStaticMarkup(<AddressCheckNote {...shown} view={null} canUnfreeze />)).toBe("");
  });
});
