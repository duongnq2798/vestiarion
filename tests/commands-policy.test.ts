import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { accessOf, consoleActor, cycleEventOf, memberActor, provenanceOf, type Actor } from "@/lib/commands/actor";
import { ActorScopeError, COMMAND_PERMISSIONS, gate, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * The actor and the gate every command passes first (integrations design §8, R2, R4, R7): the scope must be the
 * actor's workspace, the role must hold the command's permission, and the surface must be one that may run it. A
 * member acting through a chat or a key is read from the database for the action, never believed from the link.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c02";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c3";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const actor = (fields: Partial<Actor> = {}): Actor => ({
  orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields,
});
const inScope = <T,>(orgId: string, fn: () => T) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId }), fn);

describe("gate", () => {
  it("lets a role with the permission run a command its surface may run", () => {
    expect(inScope(ORG, () => gate(actor(), "payable.approve"))).toBeNull();
  });

  it("refuses a role without the permission, in the console's words", () => {
    expect(inScope(ORG, () => gate(actor({ role: "viewer" }), "payable.approve"))).toEqual({
      ok: false, code: "forbidden", message: "Your role in this workspace (viewer) cannot do that.",
    });
  });

  it("refuses a command the surface may not run", () => {
    const telegram = actor({ role: "owner", surface: { kind: "telegram", linkId: "l-1" } });
    expect(inScope(ORG, () => gate(telegram, "payable.approve"))).toMatchObject({ ok: false, code: "surface" });
    expect(inScope(ORG, () => gate(telegram, "invoice.add"))).toBeNull();
  });

  it("throws when the scope is another workspace's", () => {
    expect(() => inScope(OTHER, () => gate(actor(), "payable.approve"))).toThrow(ActorScopeError);
  });
});

describe("what each surface may run (R4)", () => {
  it("lets the console run every command", () => {
    expect([...SURFACE_COMMANDS.console].sort()).toEqual(Object.keys(COMMAND_PERMISSIONS).sort());
  });

  it("lets Telegram add invoices only, the API add records only, and Slack decide a held payable, pause the agent and add invoices", () => {
    expect(SURFACE_COMMANDS.telegram).toEqual(["invoice.add"]);
    // The API adds records and never decides (write API R3; part 2, W4).
    expect(SURFACE_COMMANDS.api).toEqual(["invoice.add", "milestone.add", "payee_link.create"]);
    expect(SURFACE_COMMANDS.slack).toEqual(["payable.approve", "payable.reject", "payable.return", "agent.pause", "invoice.add"]);
  });

  it("lets an owner add an invoice from Slack whether or not deciding there is on, and refuses an approver", () => {
    const off = actor({ role: "owner", surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: null } });
    expect(inScope(ORG, () => gate(off, "invoice.add"))).toBeNull();
    const approver = actor({ role: "approver", surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: 5 } });
    expect(inScope(ORG, () => gate(approver, "invoice.add"))).toMatchObject({ code: "forbidden" });
  });

  it("refuses a decision from Slack while its workspace allows none there, and lets it pause", () => {
    const off = actor({ surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: null } });
    expect(inScope(ORG, () => gate(off, "payable.reject"))).toMatchObject({ ok: false, code: "decisions_off" });
    expect(inScope(ORG, () => gate(off, "agent.pause"))).toBeNull();
    expect(inScope(ORG, () => gate(off, "agent.resume"))).toMatchObject({ code: "forbidden" });
    const on = actor({ role: "owner", surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: 5 } });
    expect(inScope(ORG, () => gate(on, "payable.approve"))).toBeNull();
    expect(inScope(ORG, () => gate(on, "agent.resume"))).toMatchObject({ code: "surface" });
  });

  it("asks the permission map's own permissions", () => {
    expect(COMMAND_PERMISSIONS["payable.approve"]).toBe("approval.decide");
    expect(COMMAND_PERMISSIONS["payable.add_details"]).toBe("records.write");
    expect(COMMAND_PERMISSIONS["agent.resume"]).toBe("agent.resume");
  });
});

describe("the actor", () => {
  it("takes the console's person from authorize", () => {
    expect(consoleActor({ user: { id: USER }, membership: { orgId: ORG, role: "admin", mode: "sandbox" } })).toEqual({
      orgId: ORG, userId: USER, role: "admin", mode: "sandbox", surface: { kind: "console" },
    });
  });

  it("records nothing for the console, and the link or key for any other surface (R3)", () => {
    expect(provenanceOf(actor())).toEqual({});
    expect(provenanceOf(actor({ surface: { kind: "telegram", linkId: "l-1" } }))).toEqual({ provenance: { via: "telegram", linkId: "l-1" } });
    expect(provenanceOf(actor({ surface: { kind: "slack", linkId: "l-2", decisionsLimitUsdc: 5 } }))).toEqual({ provenance: { via: "slack", linkId: "l-2" } });
    expect(provenanceOf(actor({ surface: { kind: "api", apiKeyId: "k-1" } }))).toEqual({ provenance: { via: "api", apiKeyId: "k-1" } });
  });

  it("hands the follow-ups what they take", () => {
    expect(accessOf(actor())).toEqual({ user: { id: USER }, membership: { orgId: ORG, mode: "live" } });
    expect(cycleEventOf(actor({ mode: "sandbox" }), "payable_returned")).toEqual({ orgId: ORG, userId: USER, sandbox: true, kind: "payable_returned" });
  });
});

describe("memberActor", () => {
  function world(membership: unknown, org: unknown) {
    const fake = fakeSupabase((request) => {
      if (request.path === "/rest/v1/memberships") return { body: membership };
      if (request.path === "/rest/v1/orgs") return { body: org };
      return { body: [] };
    });
    return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
  }

  it("reads the role and the workspace's mode now, for this one action", async () => {
    const { fake, run } = world([{ role: "admin" }], [{ mode: "live" }]);
    expect(await run(() => memberActor(ORG, USER, { kind: "telegram", linkId: "l-1" }))).toEqual({
      orgId: ORG, userId: USER, role: "admin", mode: "live", surface: { kind: "telegram", linkId: "l-1" },
    });
    const membership = fake.requests.find((request) => request.path === "/rest/v1/memberships");
    expect(membership?.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(membership?.params.get("user_id")).toBe(`eq.${USER}`);
  });

  it("is null for someone no longer a member, and reads nothing more", async () => {
    const { fake, run } = world([], [{ mode: "live" }]);
    expect(await run(() => memberActor(ORG, USER, { kind: "telegram", linkId: "l-1" }))).toBeNull();
    expect(fake.requests.some((request) => request.path === "/rest/v1/orgs")).toBe(false);
  });

  it("is null for a role the map does not know", async () => {
    const { run } = world([{ role: "superuser" }], [{ mode: "live" }]);
    expect(await run(() => memberActor(ORG, USER, { kind: "slack", linkId: "l-2", decisionsLimitUsdc: null }))).toBeNull();
  });
});
