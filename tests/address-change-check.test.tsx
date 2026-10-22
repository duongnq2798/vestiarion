import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerAddressChange,
  askContactAboutAddressChange,
  checkLine,
  checkTokenHash,
  counterpartyFrozen,
  generateCheckToken,
  previewAddressChange,
  readAddressChecks,
  readFrozenPayees,
  unfreezeCounterparty,
  UnfreezeError,
  viaWords,
} from "@/lib/address-change-check";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { addressChangeCheckEmail } from "@/lib/email/address-change-check";
import { addressChangeDisputedEmail } from "@/lib/email/address-change-disputed";
import { sendEmail } from "@/lib/email/send";
import { fakeSupabase, type RecordedRequest } from "./support/fake-supabase";
import { APPENDED_LEDGER_ROW, signedOrgs } from "./support/signed-org";

/**
 * "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC1-AC5): the payee's contact asked
 * on a change from one address to another, in a live workspace only; the email's words; the page's preview and answer;
 * owners and admins told of a "not me"; unfreezing; and what Counterparties reads.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/usage/record", () => ({ recordUsage: vi.fn(), recordUsageFor: vi.fn() }));
// The tests' deployment simulates every chain: a live workspace here stands for one that pays for real.
vi.mock("@/lib/capability-read", () => ({ simulatesPayments: (mode?: string) => mode === "sandbox" }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const CHECK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000c4ec4";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const OLD = "0x1111111111111111111111111111111111111111";
const NEW = "0x7a2dC41e9b03F6a85d1c27e4b98f0a3c61d5e10d";

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const orgs = signedOrgs();
const sent = vi.mocked(sendEmail);

beforeEach(() => {
  sent.mockReset();
  sent.mockResolvedValue({ sent: true, id: "email-1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

type Answer = (request: RecordedRequest) => { status?: number; body: unknown } | undefined;

function world(answer: Answer = () => undefined, org: Record<string, unknown> = {}) {
  const fake = fakeSupabase((request) => {
    const given = answer(request);
    if (given) return given;
    if (request.path === "/rest/v1/orgs") return { body: orgs.orgRow(ORG, { name: "Pinecrest Studio", slug: "pinecrest", mode: "live", ...org }) };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") return { body: APPENDED_LEDGER_ROW };
    if (request.path === "/rest/v1/counterparties") return { body: { name: "Northwind", notice_email: "ap@northwind.example" } };
    if (request.path === "/rest/v1/rpc/create_address_change_check") {
      return { body: { id: CHECK, created_at: "2026-10-22T09:15:00.000Z", expires_at: "2026-10-29T09:15:00.000Z" } };
    }
    if (request.path === "/rest/v1/rpc/mark_address_change_check_sent") return { body: true };
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn);
  return { fake, run };
}

const ledger = (requests: RecordedRequest[]) =>
  requests.filter((request) => request.path === "/rest/v1/rpc/append_ledger_entry").map((request) => request.body as { p_action: string; p_detail: Record<string, unknown> });

describe("the link (AC2)", () => {
  it("keeps only a hash of a vxw_ token, and reads nothing else as one", () => {
    const { token, tokenHash } = generateCheckToken();
    expect(token).toMatch(/^vxw_[A-Za-z0-9_-]{43}$/);
    expect(checkTokenHash(token)).toBe(tokenHash);
    expect(checkTokenHash("vxo_" + token.slice(4))).toBeNull();
    expect(checkTokenHash("")).toBeNull();
  });
});

describe("asking the payee's contact (AC1)", () => {
  const ask = (run: ReturnType<typeof world>["run"], over: Partial<Parameters<typeof askContactAboutAddressChange>[0]> = {}) =>
    run(() => askContactAboutAddressChange({ orgId: ORG, counterpartyId: COUNTERPARTY, from: OLD, to: NEW, via: "member", ...over }));

  it("emails the notice email on file, marks the check sent, and signs it without the email", async () => {
    const { fake, run } = world();
    expect(await ask(run)).toBe("asked");
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0]).toMatchObject({ to: "ap@northwind.example", subject: "Did you change where Pinecrest Studio pays you?", meter: "address_change_check" });
    const made = fake.requests.find((request) => request.path === "/rest/v1/rpc/create_address_change_check")?.body as Record<string, unknown>;
    expect(made).toMatchObject({ p_org_id: ORG, p_counterparty_id: COUNTERPARTY, p_from: OLD, p_to: NEW, p_via: "member", p_sent_to: "ap@northwind.example" });
    expect(String(made.p_token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/mark_address_change_check_sent")).toBe(true);
    const [entry] = ledger(fake.requests);
    expect(entry).toMatchObject({ p_action: "address_change_check_sent", p_detail: { counterpartyId: COUNTERPARTY, checkId: CHECK, from: OLD, to: NEW, via: "member", contact: "notice_email" } });
    expect(JSON.stringify(entry)).not.toContain("northwind.example");
  });

  it("asks nothing for a cleared address, or a first one the payee never had before", async () => {
    const { fake, run } = world();
    expect(await ask(run, { to: null })).toBe("not_asked");
    expect(fake.requests).toHaveLength(0);
    expect(await ask(run, { from: null })).toBe("not_asked");
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/create_address_change_check")).toBe(false);
    expect(sent).not.toHaveBeenCalled();
  });

  it("asks about the address cleared before, when a new one is set after it", async () => {
    const { fake, run } = world((request) =>
      request.path === "/rest/v1/ledger_entries"
        ? {
            body: [
              { action: "counterparty_address_changed", detail: { counterpartyId: COUNTERPARTY, from: null, to: NEW } },
              { action: "counterparty_address_changed", detail: { counterpartyId: COUNTERPARTY, from: OLD, to: null } },
              { action: "create_counterparty", detail: { counterpartyId: COUNTERPARTY, address: OLD } },
            ],
          }
        : undefined
    );
    expect(await ask(run, { from: null })).toBe("asked");
    const made = fake.requests.find((request) => request.path === "/rest/v1/rpc/create_address_change_check")?.body as Record<string, unknown>;
    expect(made).toMatchObject({ p_from: OLD, p_to: NEW });
    const read = fake.requests.find((request) => request.path === "/rest/v1/ledger_entries");
    expect(read?.params.get("detail->>counterpartyId")).toBe(`eq.${COUNTERPARTY}`);
  });

  it("keeps the member who changed it, and sends nothing for an ask that runs after the address changed again", async () => {
    const asked = world();
    await ask(asked.run, { changedBy: USER });
    expect(asked.fake.requests.find((request) => request.path === "/rest/v1/rpc/create_address_change_check")?.body).toMatchObject({ p_changed_by: USER });
    sent.mockClear();
    const late = world((request) => (request.path === "/rest/v1/rpc/create_address_change_check" ? { body: null } : undefined));
    expect(await ask(late.run)).toBe("not_asked");
    expect(sent).not.toHaveBeenCalled();
    expect(ledger(late.fake.requests)).toHaveLength(0);
  });

  it("asks nothing in a sandbox, in shadow mode, or with no notice email", async () => {
    const sandbox = world(undefined, { mode: "sandbox" });
    expect(await ask(sandbox.run)).toBe("not_asked");
    const shadow = world((request) => (request.path === "/rest/v1/shadow_modes" ? { body: [{ currency: "USD", started_at: "2026-10-01T00:00:00Z", started_by: USER }] } : undefined));
    expect(await ask(shadow.run)).toBe("not_asked");
    const noEmail = world((request) => (request.path === "/rest/v1/counterparties" ? { body: { name: "Northwind", notice_email: null } } : undefined));
    expect(await ask(noEmail.run)).toBe("not_asked");
    for (const { fake } of [sandbox, shadow, noEmail]) {
      expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/create_address_change_check")).toBe(false);
    }
    expect(sent).not.toHaveBeenCalled();
  });

  it("asks nothing before migration 0137, and never throws", async () => {
    const { run } = world((request) =>
      request.path === "/rest/v1/rpc/create_address_change_check" ? { status: 404, body: { code: "PGRST202", message: "Could not find the function" } } : undefined
    );
    expect(await ask(run)).toBe("not_asked");
    expect(sent).not.toHaveBeenCalled();
    const broken = world((request) => (request.path === "/rest/v1/counterparties" ? { status: 500, body: { code: "XX000", message: "down" } } : undefined));
    expect(await ask(broken.run)).toBe("not_asked");
  });

  it("leaves a check whose email did not go unsent and unsigned", async () => {
    sent.mockResolvedValue({ sent: false, reason: "not_configured" });
    const { fake, run } = world();
    expect(await ask(run)).toBe("not_sent");
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/mark_address_change_check_sent")).toBe(false);
    expect(ledger(fake.requests)).toHaveLength(0);
  });

  it("names a payee link and a GitHub login as how it changed", async () => {
    const { run } = world();
    await ask(run, { via: "payee_link" });
    expect(sent.mock.calls[0][0].text).toContain("was changed through your payment link");
    await ask(run, { via: "github", githubLogin: "ana" });
    expect(sent.mock.calls[1][0].text).toContain("was changed on GitHub, by @ana");
  });
});

describe("the email (AC2)", () => {
  const email = addressChangeCheckEmail({
    orgName: "Pinecrest Studio",
    payeeName: "Northwind",
    from: OLD,
    to: NEW,
    via: "member",
    githubLogin: null,
    changedAt: "2026-10-22T09:15:00.000Z",
    link: "https://www.vestiarion.xyz/address-change/vxw_x",
    expiresAt: new Date("2026-10-29T09:15:00.000Z"),
    origin: "https://www.vestiarion.xyz",
  });

  it("shows the address before shortened and the new one whole, when and how it changed, and one link", () => {
    expect(email.text).toContain("The address Pinecrest Studio pays you at was changed by someone at Pinecrest Studio, on 22 October 2026, 09:15 UTC.");
    expect(email.text).toContain("Before: 0x1111...1111");
    expect(email.text).toContain(`Now: ${NEW}`);
    expect(email.text).toContain("payments to the new address stop until someone at Pinecrest Studio checks with you");
    expect(email.text).toContain("This link never asks for a password, a key or a payment.");
    expect(email.html).toContain("Review this change");
    expect(email.html).toContain("https://www.vestiarion.xyz/address-change/vxw_x");
  });

  it("carries no link back to Vestiarion's landing page: it is a security message", () => {
    expect(email.html).not.toContain("Run your own bills with it");
    expect(email.html).not.toContain("utm_source");
  });

  it("tells owners and admins whether the payee is frozen", () => {
    const frozen = addressChangeDisputedEmail({ orgName: "Pinecrest Studio", payeeName: "Northwind", to: NEW, frozen: true, link: "https://x/o/p/counterparties", origin: "https://x" });
    expect(frozen.subject).toBe("Northwind says they did not change their payment address");
    expect(frozen.text).toContain("Northwind is frozen");
    const moved = addressChangeDisputedEmail({ orgName: "Pinecrest Studio", payeeName: "Northwind", to: NEW, frozen: false, link: "https://x/o/p/counterparties", origin: "https://x" });
    expect(moved.text).toContain("nothing was frozen");
  });
});

describe("the payee's page (AC3)", () => {
  it("previews an open check, and asks nothing for a link that is not one", async () => {
    const { token } = generateCheckToken();
    const { fake, run } = world((request) =>
      request.path === "/rest/v1/rpc/address_change_check_preview"
        ? {
            body: [
              {
                org_name: "Pinecrest Studio",
                counterparty_name: "Northwind",
                from_address: OLD,
                to_address: NEW,
                via: "payee_link",
                github_login: null,
                created_at: "2026-10-22T09:15:00Z",
                expires_at: "2026-10-29T09:15:00Z",
              },
            ],
          }
        : undefined
    );
    expect(await run(() => previewAddressChange(token))).toMatchObject({ orgName: "Pinecrest Studio", payeeName: "Northwind", from: OLD, to: NEW, via: "payee_link" });
    expect(await run(() => previewAddressChange("not-a-token"))).toBeNull();
    expect(fake.requests.filter((request) => request.path === "/rest/v1/rpc/address_change_check_preview")).toHaveLength(1);
  });

  function answering(outcome: string, broken = false) {
    return world((request) => {
      if (request.path === "/rest/v1/rpc/answer_address_change_check") {
        const valid = outcome !== "not_valid";
        return {
          body: [
            {
              outcome,
              check_id: valid ? CHECK : null,
              org_id: valid ? ORG : null,
              counterparty_id: valid ? COUNTERPARTY : null,
              from_address: OLD,
              to_address: NEW,
              org_name: valid ? "Pinecrest Studio" : null,
              org_slug: valid ? "pinecrest" : null,
              counterparty_name: valid ? "Northwind" : null,
            },
          ],
        };
      }
      if (broken && (request.path === "/rest/v1/rpc/append_ledger_entry" || request.path === "/rest/v1/orgs")) {
        return { status: 500, body: { code: "XX000", message: "down" } };
      }
      if (request.path === "/rest/v1/rpc/org_members") {
        return {
          body: [
            { user_id: "u1", email: "owner@pinecrest.example", role: "owner", joined_at: "2026-10-01T00:00:00Z" },
            { user_id: "u2", email: "approver@pinecrest.example", role: "approver", joined_at: "2026-10-01T00:00:00Z" },
          ],
        };
      }
      return undefined;
    });
  }

  it("records yes, and tells no one", async () => {
    const { token } = generateCheckToken();
    const { fake, run } = answering("confirmed");
    expect(await run(() => answerAddressChange(token, false))).toBe("confirmed");
    expect(ledger(fake.requests).map((entry) => entry.p_action)).toEqual(["address_change_answered"]);
    expect(ledger(fake.requests)[0].p_detail).toMatchObject({ by: null, via: "address_check", answer: "me", counterpartyId: COUNTERPARTY });
    expect(sent).not.toHaveBeenCalled();
  });

  it("freezes on not me, signs both entries, and emails the owners and admins only, after the payee's answer", async () => {
    const { token } = generateCheckToken();
    const { fake, run } = answering("frozen");
    const deferred: Array<() => Promise<unknown>> = [];
    expect(await run(() => answerAddressChange(token, true, { defer: (work) => deferred.push(work) }))).toBe("frozen");
    expect(ledger(fake.requests).map((entry) => entry.p_action)).toEqual(["address_change_answered", "counterparty_frozen"]);
    expect(ledger(fake.requests)[1].p_detail).toMatchObject({ counterpartyId: COUNTERPARTY, checkId: CHECK, address: NEW, reason: "address_change_disputed" });
    expect(sent).not.toHaveBeenCalled();
    await run(() => deferred[0]());
    expect(sent.mock.calls.map((call) => call[0].to)).toEqual(["owner@pinecrest.example"]);
    expect(sent.mock.calls[0][0].subject).toBe("Northwind says they did not change their payment address");
    expect(sent.mock.calls[0][0].text).toContain("/o/pinecrest/counterparties");
  });

  it("still tells the owners and admins when nothing else can be read or signed", async () => {
    const { token } = generateCheckToken();
    const { run } = answering("frozen", true);
    expect(await run(() => answerAddressChange(token, true))).toBe("frozen");
    expect(sent.mock.calls.map((call) => call[0].to)).toEqual(["owner@pinecrest.example"]);
  });

  it("takes nothing for a link that answers nothing", async () => {
    const { token } = generateCheckToken();
    const { fake, run } = answering("not_valid");
    expect(await run(() => answerAddressChange(token, true))).toBe("not_valid");
    expect(await run(() => answerAddressChange("nope", true))).toBe("not_valid");
    expect(ledger(fake.requests)).toHaveLength(0);
  });
});

describe("unfreezing (AC4)", () => {
  const unfreeze = (run: ReturnType<typeof world>["run"], over: Partial<Parameters<typeof unfreezeCounterparty>[0]> = {}) =>
    run(() => withOrg(ORG, () => unfreezeCounterparty({ orgId: ORG, actorId: USER, role: "owner", counterpartyId: COUNTERPARTY, note: "Called their finance lead on the number we had.", ...over }), { userId: USER }));

  it("needs an owner or admin, and a note", async () => {
    const { fake, run } = world();
    await expect(unfreeze(run, { role: "approver" })).rejects.toThrow(UnfreezeError);
    await expect(unfreeze(run, { note: " " })).rejects.toThrow("Say how you checked with the payee");
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/unfreeze_counterparty")).toBe(false);
  });

  const frozenWorld = (changedBy: string | null, extra: Answer = () => undefined) =>
    world((request) => {
      const given = extra(request);
      if (given) return given;
      if (request.path === "/rest/v1/counterparties") return { body: { name: "Northwind", frozen_check_id: CHECK } };
      if (request.path === "/rest/v1/address_change_checks") return { body: { changed_by: changedBy } };
      if (request.path === "/rest/v1/rpc/unfreeze_counterparty") return { body: [{ frozen_at: "2026-10-22T10:00:00Z", frozen_check_id: CHECK }] };
      if (request.path === "/rest/v1/rpc/org_members") {
        return {
          body: [
            { user_id: USER, email: "owner@pinecrest.example", role: "owner", joined_at: "2026-10-01T00:00:00Z" },
            { user_id: "u2", email: "admin@pinecrest.example", role: "admin", joined_at: "2026-10-01T00:00:00Z" },
          ],
        };
      }
      return undefined;
    });

  it("unfreezes a frozen payee and signs the note", async () => {
    const { fake, run } = frozenWorld("someone-else");
    await unfreeze(run);
    const [entry] = ledger(fake.requests);
    expect(entry).toMatchObject({
      p_action: "counterparty_unfrozen",
      p_detail: { by: USER, counterpartyId: COUNTERPARTY, checkId: CHECK, note: "Called their finance lead on the number we had." },
    });
  });

  it("is not done by whoever made the disputed change while another owner or admin can", async () => {
    const { fake, run } = frozenWorld(USER);
    await expect(unfreeze(run)).rejects.toThrow("You made the change this payee disputed, so another owner or admin unfreezes it.");
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/unfreeze_counterparty")).toBe(false);
    const alone = frozenWorld(USER, (request) =>
      request.path === "/rest/v1/rpc/org_members" ? { body: [{ user_id: USER, email: "owner@pinecrest.example", role: "owner", joined_at: "2026-10-01T00:00:00Z" }] } : undefined
    );
    await unfreeze(alone.run);
    expect(ledger(alone.fake.requests)[0]).toMatchObject({ p_action: "counterparty_unfrozen" });
  });

  it("puts the freeze back when its entry cannot be signed", async () => {
    const { fake, run } = frozenWorld("someone-else", (request) =>
      request.path === "/rest/v1/rpc/append_ledger_entry"
        ? { status: 500, body: { code: "XX000", message: "ledger unavailable" } }
        : request.path === "/rest/v1/rpc/restore_counterparty_freeze"
          ? { body: true }
          : undefined
    );
    await expect(unfreeze(run)).rejects.toThrow();
    const restored = fake.requests.find((request) => request.path === "/rest/v1/rpc/restore_counterparty_freeze")?.body;
    expect(restored).toMatchObject({ p_org_id: ORG, p_counterparty_id: COUNTERPARTY, p_frozen_at: "2026-10-22T10:00:00Z", p_check_id: CHECK });
  });

  it("says so when the payee is not frozen", async () => {
    const { run } = frozenWorld(null, (request) => (request.path === "/rest/v1/rpc/unfreeze_counterparty" ? { body: [] } : undefined));
    await expect(unfreeze(run)).rejects.toThrow("This payee is not frozen.");
  });
});

describe("what Counterparties reads (AC5)", () => {
  function reader(answer: Answer) {
    const fake = fakeSupabase((request) => answer(request) ?? { body: [] });
    return fake.client as unknown as Parameters<typeof readAddressChecks>[1];
  }

  it("reads each payee's freeze and its latest check sent", async () => {
    const db = reader((request) => {
      if (request.path === "/rest/v1/counterparties") return { body: [{ id: "a", frozen_at: "2026-10-22T10:00:00Z" }] };
      if (request.path === "/rest/v1/address_change_checks") {
        return {
          body: [
            { counterparty_id: "b", status: "confirmed", sent_at: "2026-10-22T09:00:00Z", created_at: "2026-10-22T09:00:00Z", to_address: NEW },
            { counterparty_id: "b", status: "open", sent_at: "2026-10-20T09:00:00Z", created_at: "2026-10-20T09:00:00Z", to_address: OLD },
          ],
        };
      }
      return undefined;
    });
    const views = await readAddressChecks(["a", "b"], db);
    expect(views.get("a")).toEqual({ frozen: true, check: null });
    expect(views.get("b")).toMatchObject({ frozen: false, check: { status: "confirmed", to: NEW } });
  });

  it("reads which payees are frozen, for Approvals", async () => {
    const db = reader((request) => (request.path === "/rest/v1/counterparties" ? { body: [{ id: "a" }] } : undefined));
    expect([...(await readFrozenPayees(["a", "b"], db))]).toEqual(["a"]);
    const before = reader(() => ({ status: 400, body: { code: "42703", message: "column counterparties.frozen_at does not exist" } }));
    expect((await readFrozenPayees(["a"], before)).size).toBe(0);
  });

  it("reads none before migration 0137, and stops on any other failure", async () => {
    const before = reader(() => ({ status: 400, body: { code: "42703", message: "column counterparties.frozen_at does not exist" } }));
    expect((await readAddressChecks(["a"], before)).size).toBe(0);
    expect(await counterpartyFrozen("a", before)).toBe(false);
    const down = reader(() => ({ status: 500, body: { code: "XX000", message: "down" } }));
    await expect(readAddressChecks(["a"], down)).rejects.toThrow();
    await expect(counterpartyFrozen("a", down)).rejects.toThrow();
  });

  it("says what a row shows", () => {
    expect(checkLine({ status: "open", sentAt: null, frozen: true })).toContain("Frozen");
    expect(checkLine({ status: "confirmed", sentAt: "x", frozen: false })).toBe("Their billing email said they made this change.");
    expect(checkLine({ status: "open", sentAt: "x", frozen: false })).toContain("has not answered yet");
    expect(checkLine({ status: "open", sentAt: "x", frozen: false, expired: true })).toBe("Their billing email was asked whether they made this change, and did not answer.");
    expect(checkLine({ status: "open", sentAt: null, frozen: false })).toBeNull();
    expect(viaWords("github", "Pinecrest", null)).toBe("on GitHub");
    expect(renderToStaticMarkup(<p>{viaWords("member", "Pinecrest", null)}</p>)).toContain("by someone at Pinecrest");
  });
});
