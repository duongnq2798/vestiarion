# Integrations Phase 0: Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One layer, `src/lib/commands/`, through which the console and the Telegram bot take a person's actions, so a
new surface adds an adapter and never a second gate, a second set of follow-ups, or a second way of recording where an
action came from.

**Architecture:** An `Actor` is a member acting through a surface. Each command is one exported function
`(actor, input) → CommandOutcome` whose first statement is `gate(actor, "<name>")` (scope, permission, surface
policy). It calls the existing domain function unchanged except for an optional `provenance`, raises the follow-ups
(cycle event, payee notices), and returns the console's own words. The console's server actions and the bot's **Add**
become thin adapters.

**Tech Stack:** Next.js 16 server actions, TypeScript, Supabase (supabase-js, PostgREST), Vitest with the recorded
`fakeSupabase`.

**Spec:** `docs/superpowers/specs/2026-10-03-integrations-design.md` (§3.2 G1–G4, §8, §9 Phase 0, rulings R1–R7).

## Global Constraints

- No migration, no new environment variable.
- Nothing a person or an integrator sees changes: every message the console and the bot show, every ledger entry,
  every API response and webhook payload stay byte-for-byte as they are. The existing tests of these surfaces pass,
  except the three assertions in `tests/cycle-events-actions.test.ts` that pinned the event to the action's layer
  (Task 3 and Task 5 move them to the command's layer).
- The console records no `via` (R3). A domain function spreads `provenance` into its entry's `detail` only when given.
- Do not edit the files `feat/write-api` changes: `src/app/actions/intake.ts`, `src/lib/invoices/create.ts`,
  `src/lib/api/*`, `src/lib/mcp/*`, `src/app/api/v1/*`.
- Repository wording stays neutral. Commit messages are plain imperative sentences with the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `npm run verify` (lockfile check, typecheck, lint, tests) is green at the end of every task.

## Review Focus

1. A surface that enters workspace A's scope and runs a command for an actor of workspace B: the gate must throw, not
   act (Task 1 test "throws when the scope is another workspace's").
2. A chat link that outlived its membership: `memberActor` answers null, and the bot refuses without using the draft
   (Task 1 test "is null for someone no longer a member"; the existing viewer test in `tests/telegram-intake.test.ts`).
3. An approval whose transfer failed: the person reads a failure, and the console still refreshes its pages, since the
   invoice is now held with the reason (Task 3 test "refuses a held transfer, marked changed").
4. A role lowered between the page loading and the click: the console's `authorize` refuses first; a command called
   with a stale actor is refused by `gate` (Task 1 "refuses a role without the permission").
5. A command that throws something unexpected: the console shows its generic words and the server log keeps the error
   (Task 3, Task 4 and Task 5 "logs and answers in general words").

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/provenance.ts` (new) | `Provenance`: where a person's action came from, when not the console |
| `src/lib/commands/actor.ts` (new) | `Actor`, `Surface`, `consoleActor`, `memberActor`, `provenanceOf`, `accessOf`, `cycleEventOf` |
| `src/lib/commands/outcome.ts` (new) | `CommandOutcome`, `Done`, `Refused`, `done`, `refused`, `TRY_AGAIN` |
| `src/lib/commands/policy.ts` (new) | `COMMAND_PERMISSIONS`, `SURFACE_COMMANDS`, `gate`, `ActorScopeError` |
| `src/lib/commands/payables.ts` (new) | `approvePayable`, `rejectPayable`, `returnPayable`, `addPayableDetails`, `heldMessage` |
| `src/lib/commands/milestones.ts` (new) | `payMilestoneNow`, `closeMilestoneUnpaid` |
| `src/lib/commands/agent.ts` (new) | `pauseWorkspaceAgent`, `resumeWorkspaceAgent`, `runWorkspaceCycle` |
| `src/lib/commands/invoices.ts` (new) | `addInvoice` |
| `src/lib/commands/index.ts` (new) | re-exports |
| `src/app/actions/command-result.ts` (new) | `consoleAnswer`: the console's words for an outcome, pages refreshed when anything changed |
| `src/lib/agent/approvals.ts` | optional `provenance` on `approveAndPay`, `rejectInvoice`, `returnInvoice`, `addInvoiceDetails` |
| `src/lib/agent/milestone-decisions.ts` | optional `provenance` on `payHeldMilestone`, `closeMilestone` |
| `src/lib/platform/pause.ts` | optional `provenance` on `pauseAgent`, `resumeAgent` |
| `src/app/actions/approvals.ts`, `milestones.ts` (Pay now, Close), `agent.ts` (Run, Pause, Resume) | call commands |
| `src/lib/telegram/intake.ts` | `addDraft` builds its actor with `memberActor` and adds through `addInvoice` |
| `ARCHITECTURE.md` | a "Commands" section |

---

### Task 1: Actor, outcome and gate

**Files:**
- Create: `src/lib/provenance.ts`, `src/lib/commands/actor.ts`, `src/lib/commands/outcome.ts`, `src/lib/commands/policy.ts`
- Test: `tests/commands-policy.test.ts`

**Interfaces:**
- Produces: `type Provenance = { via: "telegram" | "slack"; linkId: string } | { via: "api"; apiKeyId: string }`;
  `type Surface`, `type SurfaceKind`, `interface Actor { orgId; userId; role: OrgRole; mode: "sandbox" | "live"; surface }`;
  `consoleActor(access: ConsoleAccess): Actor`;
  `memberActor(orgId, userId, surface: Exclude<Surface, { kind: "console" }>): Promise<Actor | null>`;
  `provenanceOf(actor): { provenance?: Provenance }`; `accessOf(actor)`; `cycleEventOf(actor, kind): CycleEvent`;
  `type CommandOutcome<T>`, `Done<T>`, `Refused { ok: false; code; message; changed?: true }`, `done(message, data?)`,
  `refused(code, message, { changed? })`, `TRY_AGAIN`;
  `COMMAND_PERMISSIONS`, `type CommandName`, `SURFACE_COMMANDS`, `gate(actor, command): Refused | null`, `ActorScopeError`.

- [ ] **Step 1: Write the failing test** `tests/commands-policy.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { consoleActor, memberActor, provenanceOf, accessOf, cycleEventOf, type Actor } from "@/lib/commands/actor";
import { ActorScopeError, COMMAND_PERMISSIONS, gate, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

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

  it("lets Telegram and the API add invoices only, and Slack nothing yet", () => {
    expect(SURFACE_COMMANDS.telegram).toEqual(["invoice.add"]);
    expect(SURFACE_COMMANDS.api).toEqual(["invoice.add"]);
    expect(SURFACE_COMMANDS.slack).toEqual([]);
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
    expect(provenanceOf(actor({ surface: { kind: "slack", linkId: "l-2" } }))).toEqual({ provenance: { via: "slack", linkId: "l-2" } });
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
    expect(await run(() => memberActor(ORG, USER, { kind: "slack", linkId: "l-2" }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/commands-policy.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/commands/actor"".

- [ ] **Step 3: Write `src/lib/provenance.ts`**

```ts
/**
 * Where a person's action came from, when it was not the console (integrations design R3). A domain function that
 * records a person's decision spreads it into its ledger entry's `detail`, so the signed entry names the surface and
 * the link or key it came through. The console passes none: an entry without `via` is the console's, as it always was.
 */
export type Provenance = { via: "telegram" | "slack"; linkId: string } | { via: "api"; apiKeyId: string };
```

- [ ] **Step 4: Write `src/lib/commands/outcome.ts`**

```ts
/**
 * What a command did, in the words the console shows (integrations design R6). A surface shows `message`, or says
 * `code` in its own words. `changed` marks a refusal after which something did change, so a surface still refreshes
 * what it shows: an approval whose transfer failed leaves the invoice held with the reason.
 */
export interface Refused {
  ok: false;
  /** `forbidden` (the role), `surface` (where it was asked from), the domain's own code, or `failed`. */
  code: string;
  message: string;
  changed?: true;
}

export type Done<T extends object = object> = { ok: true; message: string } & T;

export type CommandOutcome<T extends object = object> = Done<T> | Refused;

export function done<T extends object = object>(message: string, data?: T): Done<T> {
  return { ok: true, message, ...data } as Done<T>;
}

export function refused(code: string, message: string, options: { changed?: true } = {}): Refused {
  return { ok: false, code, message, ...options };
}

/** The words for a failure no one can act on; the error itself goes to the server log. */
export const TRY_AGAIN = "That did not work. Try again in a moment.";
```

- [ ] **Step 5: Write `src/lib/commands/actor.ts`**

```ts
import type { CycleEvent, CycleEventKind } from "../agent/cycle-soon";
import { isOrgRole, type OrgRole } from "../auth/roles";
import { platformDb } from "../dal";
import type { Provenance } from "../provenance";

/**
 * Who acts, and through which surface (integrations design §8). An actor is one member of one workspace: the console's
 * signed-in person, a member whose chat account is linked to them, or the person who issued an API key. A surface
 * other than the console builds its actor with `memberActor`, which reads the role and the workspace's mode for this
 * action (R7): nothing a link, a key or a button carries is believed about either.
 */

export type Surface =
  | { kind: "console" }
  | { kind: "telegram"; linkId: string }
  | { kind: "slack"; linkId: string }
  | { kind: "api"; apiKeyId: string };

export type SurfaceKind = Surface["kind"];

export interface Actor {
  orgId: string;
  userId: string;
  role: OrgRole;
  mode: "sandbox" | "live";
  surface: Surface;
}

/** As much of a successful `authorize` as an actor needs. */
export interface ConsoleAccess {
  user: { id: string };
  membership: { orgId: string; role: OrgRole; mode: "sandbox" | "live" };
}

/** The console's signed-in person: `authorize` has just read their role from their membership. */
export function consoleActor(access: ConsoleAccess): Actor {
  return {
    orgId: access.membership.orgId,
    userId: access.user.id,
    role: access.membership.role,
    mode: access.membership.mode,
    surface: { kind: "console" },
  };
}

/**
 * A member acting through another surface, with their role and the workspace's mode read now. Null when they are no
 * longer a member, so a link or a key that outlived its membership acts for nobody.
 */
export async function memberActor(orgId: string, userId: string, surface: Exclude<Surface, { kind: "console" }>): Promise<Actor | null> {
  const membership = await platformDb().from("memberships").select("role").eq("org_id", orgId).eq("user_id", userId).maybeSingle<{ role: unknown }>();
  if (membership.error) throw new Error(membership.error.message);
  const role = membership.data?.role;
  if (!isOrgRole(role)) return null;
  const org = await platformDb().from("orgs").select("mode").eq("id", orgId).maybeSingle<{ mode: unknown }>();
  if (org.error) throw new Error(org.error.message);
  if (!org.data) return null;
  return { orgId, userId, role, mode: org.data.mode === "live" ? "live" : "sandbox", surface };
}

/** What a domain function records about where the actor acted from (R3): nothing for the console. */
export function provenanceOf(actor: Actor): { provenance?: Provenance } {
  const surface = actor.surface;
  switch (surface.kind) {
    case "console":
      return {};
    case "telegram":
    case "slack":
      return { provenance: { via: surface.kind, linkId: surface.linkId } };
    case "api":
      return { provenance: { via: "api", apiKeyId: surface.apiKeyId } };
  }
}

/** The actor as `sendNoticesSoon` takes it. */
export function accessOf(actor: Actor): { user: { id: string }; membership: { orgId: string; mode: "sandbox" | "live" } } {
  return { user: { id: actor.userId }, membership: { orgId: actor.orgId, mode: actor.mode } };
}

/** The event an action raises for the agent, as `runCycleSoon` takes it. */
export function cycleEventOf(actor: Actor, kind: CycleEventKind): CycleEvent {
  return { orgId: actor.orgId, userId: actor.userId, sandbox: actor.mode === "sandbox", kind };
}
```

- [ ] **Step 6: Write `src/lib/commands/policy.ts`**

```ts
import { can, type Permission } from "../auth/roles";
import { currentOrgId } from "../context";
import type { Actor, SurfaceKind } from "./actor";
import { refused, type Refused } from "./outcome";

/**
 * Every command, with the permission it needs (integrations design R1). One exported function in
 * `src/lib/commands/` per entry, whose first statement is `gate(actor, "<name>")`.
 */
export const COMMAND_PERMISSIONS = {
  "payable.approve": "approval.decide",
  "payable.reject": "approval.decide",
  "payable.return": "approval.decide",
  "payable.add_details": "records.write",
  "milestone.pay": "approval.decide",
  "milestone.close": "approval.decide",
  "agent.pause": "agent.pause",
  "agent.resume": "agent.resume",
  "agent.run_cycle": "agent.run_cycle",
  "invoice.add": "records.write",
} as const satisfies Record<string, Permission>;

export type CommandName = keyof typeof COMMAND_PERMISSIONS;

/**
 * What each surface may run (R4). The console runs everything. Telegram adds invoices and decides nothing (Telegram
 * bot design R11). The API adds records and never decides (write API R3). Slack runs nothing until its own design
 * opens decisions, under a limit each workspace sets.
 */
export const SURFACE_COMMANDS: Record<SurfaceKind, readonly CommandName[]> = {
  console: Object.keys(COMMAND_PERMISSIONS) as CommandName[],
  telegram: ["invoice.add"],
  api: ["invoice.add"],
  slack: [],
};

/** A surface ran a command for an actor outside the scope it entered: a bug in that surface, never a refusal. */
export class ActorScopeError extends Error {
  constructor() {
    super("A command ran outside its actor's workspace");
    this.name = "ActorScopeError";
  }
}

/**
 * The first statement of every command. The workspace in scope must be the actor's (R2), or it throws. Then the
 * actor's role must hold the command's permission, and the surface must be one that may run it; either refusal is
 * returned before anything is read or written.
 */
export function gate(actor: Actor, command: CommandName): Refused | null {
  if (currentOrgId() !== actor.orgId) throw new ActorScopeError();
  if (!can(actor.role, COMMAND_PERMISSIONS[command])) {
    return refused("forbidden", `Your role in this workspace (${actor.role}) cannot do that.`);
  }
  if (!SURFACE_COMMANDS[actor.surface.kind].includes(command)) {
    return refused("surface", "That is done in the Vestiarion console, not from here.");
  }
  return null;
}
```

- [ ] **Step 7: Run the test**

Run: `npx vitest run tests/commands-policy.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 8: Commit**

```bash
git add src/lib/provenance.ts src/lib/commands/actor.ts src/lib/commands/outcome.ts src/lib/commands/policy.ts tests/commands-policy.test.ts
git commit -m "Add the actor and the gate every command passes first"
```

### Task 2: Provenance in the domain's entries

**Files:**
- Modify: `src/lib/agent/approvals.ts` (`approveAndPay`, `rejectInvoice`, `returnInvoice`, `addInvoiceDetails`)
- Modify: `src/lib/agent/milestone-decisions.ts` (`payHeldMilestone`, `closeMilestone`)
- Modify: `src/lib/platform/pause.ts` (`pauseAgent`, `resumeAgent`)
- Test: `tests/approvals.test.ts`, `tests/milestone-decisions.test.ts`, `tests/pause.test.ts`

**Interfaces:**
- Consumes: `Provenance` (Task 1).
- Produces: each function's input gains `provenance?: Provenance`; its entry's `detail` ends with `...input.provenance`.

- [ ] **Step 1: Write the failing tests**

In `tests/approvals.test.ts`, inside `describe("rejectInvoice")`:

```ts
  it("names the surface and its link when the decision did not come from the console", async () => {
    const { fake, run } = approvalsFake();

    await run(() => rejectInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID, via: "slack", linkId: "link-1" });
  });
```

Inside `describe("returnInvoice")`:

```ts
  it("names the surface and its link when the return did not come from the console", async () => {
    const { fake, run } = approvalsFake();

    await run(() => returnInvoice({ actorId: ACTOR, invoiceId: INVOICE_ID, provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, invoiceId: INVOICE_ID, via: "slack", linkId: "link-1" });
  });
```

Inside `describe("approveAndPay")`, after "claims, pays once, updates the invoice …":

```ts
  it("names the surface and its link in approval_paid when the approval did not come from the console", async () => {
    payInvoiceMock.mockResolvedValueOnce({ status: "paid", txRef: "0xhash", note: "", amountPaid: 150, discountTaken: 0, execution: execution() });
    const { fake, run } = approvalsFake();

    await run(() => approveAndPay({ actorId: ACTOR, invoiceId: INVOICE_ID, provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_action).toBe("approval_paid");
    expect(append.p_detail).toMatchObject({ by: ACTOR, invoiceId: INVOICE_ID, via: "slack", linkId: "link-1" });
  });
```

In `tests/pause.test.ts`, inside `describe("pauseAgent")`:

```ts
  it("names the surface and its link when the pause did not come from the console", async () => {
    const { fake, run } = pauseFake();

    await run(() => pauseAgent({ orgId: ORG, actorId: ACTOR, reason: "stop", provenance: { via: "slack", linkId: "link-1" } }));

    const [append] = rpcBodies(fake.requests, "append_ledger_entry");
    expect(append.p_detail).toEqual({ by: ACTOR, reason: "stop", via: "slack", linkId: "link-1" });
  });
```

In `tests/milestone-decisions.test.ts`, inside `describe("Close without paying")`:

```ts
  it("names the surface and its link when the close did not come from the console", async () => {
    const { run, ledger } = world();
    await run(() => closeMilestone({ actorId: ACTOR, milestoneId: MILESTONE, reason: "Paid in cash", provenance: { via: "slack", linkId: "link-1" } }));
    const [entry] = ledger();
    expect(entry.p_detail).toMatchObject({ by: ACTOR, reason: "Paid in cash", via: "slack", linkId: "link-1" });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/approvals.test.ts tests/pause.test.ts tests/milestone-decisions.test.ts -t "names the surface"`
Expected: FAIL: TypeScript accepts the extra property at runtime, so the failures are the `detail` assertions (no `via`).

- [ ] **Step 3: Implement**

In `src/lib/agent/approvals.ts`, import `import type { Provenance } from "../provenance";` and:
- `approveAndPay(input: { actorId: string; invoiceId: string; shownAddress?: string; provenance?: Provenance }, …)`;
  in its `approval_paid` detail, after `...(soleApprover ? { soleApprover: true } : {})`, add `...input.provenance`.
- `rejectInvoice(input: { actorId: string; invoiceId: string; reason?: string; provenance?: Provenance })`; its detail
  becomes `{ by: input.actorId, invoiceId: input.invoiceId, ...(reason === undefined ? {} : { reason }), ...input.provenance }`.
- `returnInvoice(input: { actorId: string; invoiceId: string; provenance?: Provenance })`; detail
  `{ by: input.actorId, invoiceId: input.invoiceId, ...input.provenance }`.
- `addInvoiceDetails(input: { …; provenance?: Provenance })`; detail
  `{ by: input.actorId, invoiceId: invoice.id, counterpartyId: invoice.counterpartyId, added, ...input.provenance }`.

In `src/lib/agent/milestone-decisions.ts`: `payHeldMilestone(input: { actorId: string; milestoneId: string; provenance?: Provenance })`
and `closeMilestone(input: { actorId: string; milestoneId: string; reason: string; provenance?: Provenance })`; each
detail ends with `...input.provenance`.

In `src/lib/platform/pause.ts`: `pauseAgent(input: { orgId: string; actorId: string; reason?: string; provenance?: Provenance })`
with detail `{ by: input.actorId, reason, ...input.provenance }`; `resumeAgent(input: { orgId: string; actorId: string; provenance?: Provenance })`
with detail `{ by: input.actorId, pausedFor, ...input.provenance }`.

Each function's doc comment gains: "`provenance`, when given, names the surface the person acted from (integrations
design R3); the console gives none."

- [ ] **Step 4: Run the domain tests**

Run: `npx vitest run tests/approvals.test.ts tests/pause.test.ts tests/milestone-decisions.test.ts`
Expected: PASS, including every existing test (the console passes no provenance, so its entries are unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/lib/agent/approvals.ts src/lib/agent/milestone-decisions.ts src/lib/platform/pause.ts tests/approvals.test.ts tests/milestone-decisions.test.ts tests/pause.test.ts
git commit -m "Let a person's decisions name the surface they came from"
```

### Task 3: Payable commands, and the console's Approvals on them

**Files:**
- Create: `src/lib/commands/payables.ts`, `src/app/actions/command-result.ts`
- Modify: `src/app/actions/approvals.ts`
- Test: `tests/commands-payables.test.ts`; modify `tests/cycle-events-actions.test.ts` (two assertions)

**Interfaces:**
- Consumes: Task 1 (`gate`, `provenanceOf`, `accessOf`, `cycleEventOf`, `done`, `refused`, `TRY_AGAIN`), Task 2.
- Produces: `approvePayable(actor, { invoiceId, shownAddress? }): Promise<CommandOutcome<{ status: "paid" | "matched"; txRef: string | null }>>`;
  `rejectPayable(actor, { invoiceId, reason }): Promise<CommandOutcome>`; `returnPayable(actor, { invoiceId }): Promise<CommandOutcome>`;
  `addPayableDetails(actor, { invoiceId, poReference, goodsReceived }): Promise<CommandOutcome>`; `heldMessage(note): string`;
  `consoleAnswer(outcome): { ok: boolean; message: string }`.

- [ ] **Step 1: Write the failing test** `tests/commands-payables.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { ApprovalError } from "@/lib/agent/approvals";
import type { Actor } from "@/lib/commands/actor";
import { addPayableDetails, approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

const { mocks } = vi.hoisted(() => ({
  mocks: { approveAndPay: vi.fn(), rejectInvoice: vi.fn(), returnInvoice: vi.fn(), addInvoiceDetails: vi.fn(), runCycleSoon: vi.fn(), sendNoticesSoon: vi.fn() },
}));
vi.mock("@/lib/agent/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/approvals")>()),
  approveAndPay: mocks.approveAndPay, rejectInvoice: mocks.rejectInvoice, returnInvoice: mocks.returnInvoice, addInvoiceDetails: mocks.addInvoiceDetails,
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c11";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c4";
const INVOICE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f1";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const approver = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("approvePayable", () => {
  it("pays as the actor, with nothing about the surface from the console, and tells the payee", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });

    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE, shownAddress: "0xdead" }));

    expect(mocks.approveAndPay).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, shownAddress: "0xdead" });
    expect(outcome).toEqual({ ok: true, message: "Paid.", status: "paid", txRef: "0xabc" });
    expect(mocks.sendNoticesSoon).toHaveBeenCalledWith({ user: { id: USER }, membership: { orgId: ORG, mode: "live" } });
  });

  it("says a submitted payment is waiting, and leaves the notice to the cycle that confirms it", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "matched", txRef: "0xabc", note: "" });
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toMatchObject({ ok: true, message: "Payment submitted; waiting for confirmation." });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("refuses a held transfer, marked changed, in the provider's words", async () => {
    mocks.approveAndPay.mockResolvedValueOnce({ status: "held", txRef: null, note: " [transfer failed: insufficient allowance]" });
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: false, code: "transfer_failed", message: "The transfer failed: insufficient allowance. The invoice is held.", changed: true });
  });

  it("passes an ApprovalError's code and words", async () => {
    mocks.approveAndPay.mockRejectedValueOnce(new ApprovalError("self_approval", "You created this invoice, so someone else must approve it."));
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: false, code: "self_approval", message: "You created this invoice, so someone else must approve it." });
  });

  it("logs and answers in general words for anything else", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.approveAndPay.mockRejectedValueOnce(new Error("connection refused"));
    const outcome = await run(() => approvePayable(approver(), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a viewer, and a surface that may not decide, before calling anything", async () => {
    expect(await run(() => approvePayable(approver({ role: "viewer" }), { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(await run(() => approvePayable(approver({ surface: { kind: "telegram", linkId: "l-1" } }), { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "surface" });
    expect(mocks.approveAndPay).not.toHaveBeenCalled();
  });
});

describe("rejectPayable, returnPayable, addPayableDetails", () => {
  it("rejects with the reason given", async () => {
    mocks.rejectInvoice.mockResolvedValueOnce(undefined);
    expect(await run(() => rejectPayable(approver(), { invoiceId: INVOICE, reason: "duplicate bill" }))).toEqual({ ok: true, message: "Rejected." });
    expect(mocks.rejectInvoice).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, reason: "duplicate bill" });
  });

  it("returns the payable, and has the agent look again", async () => {
    mocks.returnInvoice.mockResolvedValueOnce(undefined);
    const outcome = await run(() => returnPayable(approver({ mode: "sandbox" }), { invoiceId: INVOICE }));
    expect(outcome).toEqual({ ok: true, message: "Returned to the agent. It usually decides it again within a minute." });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: true, kind: "payable_returned" });
  });

  it("raises nothing when the return is refused", async () => {
    mocks.returnInvoice.mockRejectedValueOnce(new ApprovalError("payment_in_flight", "A payment for this invoice was already sent. Approve and pay records it."));
    expect(await run(() => returnPayable(approver(), { invoiceId: INVOICE }))).toMatchObject({ ok: false, code: "payment_in_flight" });
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("adds details as an owner or admin, and has the agent decide again", async () => {
    mocks.addInvoiceDetails.mockResolvedValueOnce({ poReference: "PO-100" });
    const admin = approver({ role: "admin" });
    const outcome = await run(() => addPayableDetails(admin, { invoiceId: INVOICE, poReference: "PO-100", goodsReceived: false }));
    expect(outcome).toEqual({ ok: true, message: "Details added. The agent usually decides it again within a minute." });
    expect(mocks.addInvoiceDetails).toHaveBeenCalledWith({ actorId: USER, invoiceId: INVOICE, poReference: "PO-100", goodsReceived: false });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "details_added" });
  });

  it("does not let an approver add details: approvers decide, they do not enter", async () => {
    expect(await run(() => addPayableDetails(approver(), { invoiceId: INVOICE, poReference: "PO-1", goodsReceived: true }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.addInvoiceDetails).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/commands-payables.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/commands/payables"".

- [ ] **Step 3: Write `src/lib/commands/payables.ts`**

```ts
import { addInvoiceDetails, approveAndPay, ApprovalError, rejectInvoice, returnInvoice } from "../agent/approvals";
import { runCycleSoon } from "../agent/cycle-soon";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, cycleEventOf, provenanceOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * A person's decisions on a payable the agent stopped (integrations design §9, Phase 0): the console's Approvals
 * buttons, and any surface allowed to run them. Each calls the approvals library as the console always has; what
 * follows a decision (the payee's notice, the agent's next look) is raised here, so every surface gets it (R5).
 */

/** An `ApprovalError` carries a message safe to show; anything else goes to the server log. */
function approvalRefusal(error: unknown): Refused {
  if (error instanceof ApprovalError) return refused(error.code, error.message);
  console.error("approval action failed", error);
  return refused("failed", TRY_AGAIN);
}

/**
 * `payInvoice`'s note on a failed transfer reads ` [transfer failed: <reason>]`, or ` [execution failed: <reason>]`
 * for one that never reached the provider. The reason, for the person who pressed Approve and pay; a note in neither
 * shape is shown trimmed, whole, rather than dropped.
 */
export function heldMessage(note: string): string {
  const match = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(note);
  const reason = match ? match[1] : note.trim();
  return `The transfer failed: ${reason}. The invoice is held.`;
}

export async function approvePayable(
  actor: Actor,
  input: { invoiceId: string; shownAddress?: string }
): Promise<CommandOutcome<{ status: "paid" | "matched"; txRef: string | null }>> {
  const refusal = gate(actor, "payable.approve");
  if (refusal) return refusal;
  let result: Awaited<ReturnType<typeof approveAndPay>>;
  try {
    result = await approveAndPay({ actorId: actor.userId, invoiceId: input.invoiceId, shownAddress: input.shownAddress, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  // A failed transfer leaves the invoice held with the provider's reason: something changed, and it is still a failure.
  if (result.status === "held") return refused("transfer_failed", heldMessage(result.note), { changed: true });
  // A confirmed payment's payee hears of it now, not at the next cycle (payment notices R5).
  if (result.status === "paid") sendNoticesSoon(accessOf(actor));
  return done(result.status === "paid" ? "Paid." : "Payment submitted; waiting for confirmation.", { status: result.status, txRef: result.txRef });
}

export async function rejectPayable(actor: Actor, input: { invoiceId: string; reason: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.reject");
  if (refusal) return refusal;
  try {
    await rejectInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  return done("Rejected.");
}

export async function returnPayable(actor: Actor, input: { invoiceId: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.return");
  if (refusal) return refusal;
  try {
    await returnInvoice({ actorId: actor.userId, invoiceId: input.invoiceId, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  runCycleSoon(cycleEventOf(actor, "payable_returned"));
  return done("Returned to the agent. It usually decides it again within a minute.");
}

/**
 * Adds the purchase order or goods receipt a held payable was missing (complete held invoice). Entering facts is a
 * records write, for owners and admins: an approver decides payments, and does not enter them (R1). The cycle the
 * event starts reopens the payable on the changed facts and decides it again (R4).
 */
export async function addPayableDetails(
  actor: Actor,
  input: { invoiceId: string; poReference: string | null; goodsReceived: boolean }
): Promise<CommandOutcome> {
  const refusal = gate(actor, "payable.add_details");
  if (refusal) return refusal;
  try {
    await addInvoiceDetails({ actorId: actor.userId, invoiceId: input.invoiceId, poReference: input.poReference, goodsReceived: input.goodsReceived, ...provenanceOf(actor) });
  } catch (error) {
    return approvalRefusal(error);
  }
  runCycleSoon(cycleEventOf(actor, "details_added"));
  return done("Details added. The agent usually decides it again within a minute.");
}
```

- [ ] **Step 4: Write `src/app/actions/command-result.ts`**

```ts
import "server-only";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import type { CommandOutcome } from "@/lib/commands/outcome";

/** The console's answer to a command (integrations design §9, Phase 0): its words, with its pages refreshed whenever anything changed. */
export function consoleAnswer(outcome: CommandOutcome): { ok: boolean; message: string } {
  if (outcome.ok || outcome.changed) revalidateOrgPages();
  return { ok: outcome.ok, message: outcome.message };
}
```

- [ ] **Step 5: Rewrite the four actions in `src/app/actions/approvals.ts`**

Keep the imports of `authorize`, `inOrg`, `z`, `invoiceDetailsInputSchema`, `invoiceFormRefusal`; drop
`approveAndPay`, `rejectInvoice`, `returnInvoice`, `addInvoiceDetails`, `ApprovalError`, `raiseCycleEvent`,
`revalidateOrgPages`, `sendNoticesSoon`, `fail` and `heldMessage`; add:

```ts
import { consoleActor } from "@/lib/commands/actor";
import { addPayableDetails, approvePayable, rejectPayable, returnPayable } from "@/lib/commands/payables";
import { consoleAnswer } from "./command-result";
```

and the bodies:

```ts
export async function approveInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    return consoleAnswer(await approvePayable(consoleActor(auth), { invoiceId: parsed.data, shownAddress: formString(formData, "address") }));
  });
}

export async function rejectInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    return consoleAnswer(await rejectPayable(consoleActor(auth), { invoiceId: parsed.data, reason: formString(formData, "reason") }));
  });
}

export async function returnInvoiceAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!parsed.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    return consoleAnswer(await returnPayable(consoleActor(auth), { invoiceId: parsed.data }));
  });
}

/**
 * Adds the purchase order or goods receipt a held payable was missing (complete held invoice). Entering facts is a
 * records write, for owners and admins: an approver decides payments, and does not enter them (R1).
 */
export async function addInvoiceDetailsAction(_previous: ApprovalActionResult, formData: FormData): Promise<ApprovalActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const invoiceId = invoiceIdSchema.safeParse(formString(formData, "invoiceId"));
    if (!invoiceId.success) return { ok: false, message: "That invoice is not waiting for a decision." };
    const details = invoiceDetailsInputSchema.safeParse({
      poReference: formString(formData, "poReference"),
      goodsReceived: formData.get("goodsReceived") === "on",
    });
    if (!details.success) return { ok: false, message: invoiceFormRefusal(details.error).message };
    return consoleAnswer(await addPayableDetails(consoleActor(auth), { invoiceId: invoiceId.data, ...details.data }));
  });
}
```

- [ ] **Step 6: Move two assertions in `tests/cycle-events-actions.test.ts`**

The event is now raised by the command through `runCycleSoon`. Mock both entry points of the module:

```ts
const { ORG, USER, raiseMock, runSoonMock, authorizeMock, mocks } = vi.hoisted(() => ({
  // …as before, plus:
  runSoonMock: vi.fn(),
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ raiseCycleEvent: raiseMock, runCycleSoon: runSoonMock }));
```

reset it in `beforeEach` (`runSoonMock.mockReset();`), and change the two assertions:

```ts
    expect(runSoonMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "payable_returned" });
```

```ts
    expect(runSoonMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "details_added" });
```

and in the two "raises nothing when … refused" tests add `expect(runSoonMock).not.toHaveBeenCalled();`.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/commands-payables.test.ts tests/approvals-actions.test.ts tests/cycle-events-actions.test.ts tests/access-gates.test.ts`
Expected: PASS. `tests/approvals-actions.test.ts` is unchanged and passes: the same messages, the same calls, the same
refresh rule.

- [ ] **Step 8: Commit**

```bash
git add src/lib/commands/payables.ts src/app/actions/command-result.ts src/app/actions/approvals.ts tests/commands-payables.test.ts tests/cycle-events-actions.test.ts
git commit -m "Decide a held payable through one command, whatever the surface"
```

### Task 4: Milestone commands, and the console's Pay now and Close on them

**Files:**
- Create: `src/lib/commands/milestones.ts`
- Modify: `src/app/actions/milestones.ts` (`payHeldMilestoneAction`, `closeMilestoneAction`, drop `decisionFailed`)
- Test: `tests/commands-milestones.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 2, `consoleAnswer` (Task 3).
- Produces: `payMilestoneNow(actor, { milestoneId }): Promise<CommandOutcome<{ status: string; txRef: string | null }>>`;
  `closeMilestoneUnpaid(actor, { milestoneId, reason }): Promise<CommandOutcome>`.

- [ ] **Step 1: Write the failing test** `tests/commands-milestones.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { MilestoneDecisionError } from "@/lib/agent/milestone-decisions";
import type { Actor } from "@/lib/commands/actor";
import { closeMilestoneUnpaid, payMilestoneNow } from "@/lib/commands/milestones";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

const { mocks } = vi.hoisted(() => ({ mocks: { payHeldMilestone: vi.fn(), closeMilestone: vi.fn(), sendNoticesSoon: vi.fn() } }));
vi.mock("@/lib/agent/milestone-decisions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/milestone-decisions")>()),
  payHeldMilestone: mocks.payHeldMilestone, closeMilestone: mocks.closeMilestone,
}));
vi.mock("@/lib/payment-notices-soon", () => ({ sendNoticesSoon: mocks.sendNoticesSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const MILESTONE = "1b6c1c9e-4a4f-4a7e-9b1e-0000000000f2";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const approver = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "approver", mode: "live", surface: { kind: "console" }, ...fields });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("payMilestoneNow", () => {
  it("pays as the actor and tells the payee", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "paid", txRef: "0xabc", note: "" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({ ok: true, message: "Paid.", status: "paid", txRef: "0xabc" });
    expect(mocks.payHeldMilestone).toHaveBeenCalledWith({ actorId: USER, milestoneId: MILESTONE });
    expect(mocks.sendNoticesSoon).toHaveBeenCalledTimes(1);
  });

  it("says a submitted transfer waits for Circle", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "verified", txRef: null, note: "" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toMatchObject({ ok: true, message: "Payment submitted; waiting for Circle to confirm it." });
    expect(mocks.sendNoticesSoon).not.toHaveBeenCalled();
  });

  it("refuses, marked changed, when it was not paid, with the reason from the note", async () => {
    mocks.payHeldMilestone.mockResolvedValueOnce({ status: "held", txRef: null, note: " [transfer failed: ESTIMATION_ERROR]" });
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({
      ok: false, code: "not_paid", message: "Not paid: ESTIMATION_ERROR. The milestone is still held.", changed: true,
    });
  });

  it("passes a MilestoneDecisionError's code and words, and logs anything else", async () => {
    mocks.payHeldMilestone.mockRejectedValueOnce(new MilestoneDecisionError("not_held"));
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toMatchObject({ ok: false, code: "not_held" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.payHeldMilestone.mockRejectedValueOnce(new Error("boom"));
    expect(await run(() => payMilestoneNow(approver(), { milestoneId: MILESTONE }))).toEqual({
      ok: false, code: "failed", message: "That did not work. Try again in a moment: nothing is sent twice.",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("refuses a viewer before calling anything", async () => {
    expect(await run(() => payMilestoneNow(approver({ role: "viewer" }), { milestoneId: MILESTONE }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.payHeldMilestone).not.toHaveBeenCalled();
  });
});

describe("closeMilestoneUnpaid", () => {
  it("closes with the reason given", async () => {
    mocks.closeMilestone.mockResolvedValueOnce(undefined);
    expect(await run(() => closeMilestoneUnpaid(approver(), { milestoneId: MILESTONE, reason: "Paid in cash" }))).toEqual({ ok: true, message: "Closed without paying." });
    expect(mocks.closeMilestone).toHaveBeenCalledWith({ actorId: USER, milestoneId: MILESTONE, reason: "Paid in cash" });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/commands-milestones.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/commands/milestones"".

- [ ] **Step 3: Write `src/lib/commands/milestones.ts`**

```ts
import { closeMilestone, MilestoneDecisionError, payHeldMilestone } from "../agent/milestone-decisions";
import { sendNoticesSoon } from "../payment-notices-soon";
import { accessOf, provenanceOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * A person's decisions on a milestone the agent held (held milestone actions R2, R3; integrations design §9). The
 * release still passes the contractor's risk, limit and address checks inside `payHeldMilestone`.
 */

/** A `MilestoneDecisionError` carries a message safe to show; anything else goes to the server log. */
function decisionRefusal(error: unknown): Refused {
  if (error instanceof MilestoneDecisionError) return refused(error.code, error.message);
  console.error("milestone decision failed", error instanceof Error ? error.message : error);
  return refused("failed", "That did not work. Try again in a moment: nothing is sent twice.");
}

export async function payMilestoneNow(actor: Actor, input: { milestoneId: string }): Promise<CommandOutcome<{ status: string; txRef: string | null }>> {
  const refusal = gate(actor, "milestone.pay");
  if (refusal) return refusal;
  let result: Awaited<ReturnType<typeof payHeldMilestone>>;
  try {
    result = await payHeldMilestone({ actorId: actor.userId, milestoneId: input.milestoneId, ...provenanceOf(actor) });
  } catch (error) {
    return decisionRefusal(error);
  }
  if (result.status === "paid") {
    sendNoticesSoon(accessOf(actor));
    return done("Paid.", { status: result.status, txRef: result.txRef });
  }
  if (result.status === "verified") return done("Payment submitted; waiting for Circle to confirm it.", { status: result.status, txRef: result.txRef });
  const reason = /\[(?:transfer|execution) failed:\s*(.+?)\]\s*$/.exec(result.note)?.[1] ?? /\[not paid:\s*(.+?)\]\s*$/.exec(result.note)?.[1];
  return refused("not_paid", reason ? `Not paid: ${reason}. The milestone is still held.` : "Not paid. The milestone is still held.", { changed: true });
}

export async function closeMilestoneUnpaid(actor: Actor, input: { milestoneId: string; reason: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "milestone.close");
  if (refusal) return refusal;
  try {
    await closeMilestone({ actorId: actor.userId, milestoneId: input.milestoneId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return decisionRefusal(error);
  }
  return done("Closed without paying.");
}
```

- [ ] **Step 4: Rewrite `payHeldMilestoneAction` and `closeMilestoneAction`**

In `src/app/actions/milestones.ts`, drop the imports of `closeMilestone`, `MilestoneDecisionError`, `payHeldMilestone`,
`sendNoticesSoon` and the `decisionFailed` helper; add
`import { consoleActor } from "@/lib/commands/actor";`, `import { closeMilestoneUnpaid, payMilestoneNow } from "@/lib/commands/milestones";`,
`import { consoleAnswer } from "./command-result";`:

```ts
/**
 * Pays a held milestone now (held milestone actions R2): a person's decision, by anyone who may approve a
 * held payable. The release still passes the contractor's risk, limit and address checks.
 */
export async function payHeldMilestoneAction(_previous: MilestoneActionResult, formData: FormData): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneIdSchema.safeParse(formString(formData, "milestoneId"));
    if (!parsed.success) return { ok: false, message: "Milestone not found." };
    return consoleAnswer(await payMilestoneNow(consoleActor(auth), { milestoneId: parsed.data }));
  });
}

/** Closes a held milestone without paying it, with the reason a person gives (held milestone actions R3). */
export async function closeMilestoneAction(_previous: MilestoneActionResult, formData: FormData): Promise<MilestoneActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "approval.decide");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const parsed = milestoneIdSchema.safeParse(formString(formData, "milestoneId"));
    if (!parsed.success) return { ok: false, message: "Milestone not found." };
    return consoleAnswer(await closeMilestoneUnpaid(consoleActor(auth), { milestoneId: parsed.data, reason: formString(formData, "reason") }));
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/commands-milestones.test.ts tests/held-milestone-actions.test.tsx tests/milestone-decisions.test.ts tests/access-gates.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/commands/milestones.ts src/app/actions/milestones.ts tests/commands-milestones.test.ts
git commit -m "Decide a held milestone through one command"
```

### Task 5: Agent commands, and the console's Run, Pause and Resume on them

**Files:**
- Create: `src/lib/commands/agent.ts`
- Modify: `src/app/actions/agent.ts` (`runAgentCycleAction`, `pauseAgentAction`, `resumeAgentAction`)
- Test: `tests/commands-agent.test.ts`; modify `tests/cycle-events-actions.test.ts` (one assertion)

**Interfaces:**
- Consumes: Task 1, Task 2, `consoleAnswer` (Task 3).
- Produces: `pauseWorkspaceAgent(actor, { reason }): Promise<CommandOutcome>`; `resumeWorkspaceAgent(actor): Promise<CommandOutcome>`;
  `runWorkspaceCycle(actor): Promise<CommandOutcome<{ day: number; lines: number }>>`.

- [ ] **Step 1: Write the failing test** `tests/commands-agent.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { PauseError } from "@/lib/platform/pause";
import { AgentPausedError } from "@/lib/agent/pause";
import type { Actor } from "@/lib/commands/actor";
import { pauseWorkspaceAgent, resumeWorkspaceAgent, runWorkspaceCycle } from "@/lib/commands/agent";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

const { mocks } = vi.hoisted(() => ({ mocks: { pauseAgent: vi.fn(), resumeAgent: vi.fn(), runAgentCycle: vi.fn(), runCycleSoon: vi.fn() } }));
vi.mock("@/lib/platform/pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform/pause")>()),
  pauseAgent: mocks.pauseAgent, resumeAgent: mocks.resumeAgent,
}));
vi.mock("@/lib/agent/orchestrator", () => ({
  runAgentCycle: mocks.runAgentCycle,
  agentCycleSuccessMessage: (result: { day: number }) => `Cycle complete, day ${result.day}.`,
}));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c31";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c6";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const owner = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("pauseWorkspaceAgent and resumeWorkspaceAgent", () => {
  it("pauses with the reason, as the actor", async () => {
    mocks.pauseAgent.mockResolvedValueOnce(undefined);
    expect(await run(() => pauseWorkspaceAgent(owner(), { reason: "investigating" }))).toEqual({ ok: true, message: "Agent paused." });
    expect(mocks.pauseAgent).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, reason: "investigating" });
  });

  it("lets an approver pause, and not resume", async () => {
    mocks.pauseAgent.mockResolvedValueOnce(undefined);
    expect(await run(() => pauseWorkspaceAgent(owner({ role: "approver" }), { reason: "" }))).toMatchObject({ ok: true });
    expect(await run(() => resumeWorkspaceAgent(owner({ role: "approver" })))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.resumeAgent).not.toHaveBeenCalled();
  });

  it("resumes, and has the agent look again", async () => {
    mocks.resumeAgent.mockResolvedValueOnce(undefined);
    expect(await run(() => resumeWorkspaceAgent(owner()))).toEqual({ ok: true, message: "Agent resumed." });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "agent_resumed" });
  });

  it("passes a PauseError's code and words, and logs anything else", async () => {
    mocks.pauseAgent.mockRejectedValueOnce(new PauseError("already_paused"));
    expect(await run(() => pauseWorkspaceAgent(owner(), { reason: "" }))).toEqual({ ok: false, code: "already_paused", message: "The agent is already paused." });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.resumeAgent.mockRejectedValueOnce(new Error("connection refused"));
    expect(await run(() => resumeWorkspaceAgent(owner()))).toEqual({ ok: false, code: "failed", message: "That did not work. Try again in a moment." });
    expect(log).toHaveBeenCalled();
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("runWorkspaceCycle", () => {
  it("runs a manual cycle, capped in a sandbox only", async () => {
    mocks.runAgentCycle.mockResolvedValue({ day: 4, lines: [{}, {}] });
    expect(await run(() => runWorkspaceCycle(owner({ mode: "sandbox" })))).toEqual({ ok: true, message: "Cycle complete, day 4.", day: 4, lines: 2 });
    expect(mocks.runAgentCycle).toHaveBeenLastCalledWith({ triggeredBy: USER, dailyCap: 20, trigger: { kind: "manual" } });
    await run(() => runWorkspaceCycle(owner()));
    expect(mocks.runAgentCycle).toHaveBeenLastCalledWith({ triggeredBy: USER, dailyCap: undefined, trigger: { kind: "manual" } });
  });

  it("says a pause in its own words", async () => {
    mocks.runAgentCycle.mockRejectedValueOnce(new AgentPausedError());
    const outcome = await run(() => runWorkspaceCycle(owner()));
    expect(outcome).toMatchObject({ ok: false, code: "agent_paused" });
  });

  it("refuses an approver, who may not run cycles", async () => {
    expect(await run(() => runWorkspaceCycle(owner({ role: "approver" })))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.runAgentCycle).not.toHaveBeenCalled();
  });
});
```

Before Step 3, read `src/lib/agent/pause.ts` and `src/lib/platform/pause.ts` and check two things this test assumes:
`new PauseError("already_paused")` gives the message "The agent is already paused." (the constructor takes the code
and looks its message up), and `new AgentPausedError()` takes no argument. Where either differs, construct it as the
module does and keep the assertions on `code`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/commands-agent.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/commands/agent"".

- [ ] **Step 3: Write `src/lib/commands/agent.ts`**

```ts
import { runCycleSoon } from "../agent/cycle-soon";
import { CycleRunningError } from "../agent/cycle-running";
import { agentCycleSuccessMessage, runAgentCycle } from "../agent/orchestrator";
import { AgentPausedError } from "../agent/pause";
import { SANDBOX_DAILY_CYCLES, SandboxCapReachedError } from "../agent/sandbox-cap";
import { pauseAgent, PauseError, resumeAgent } from "../platform/pause";
import { cycleEventOf, provenanceOf, type Actor } from "./actor";
import { done, refused, TRY_AGAIN, type CommandOutcome, type Refused } from "./outcome";
import { gate } from "./policy";

/**
 * Stopping, starting and running the workspace's agent (integrations design §9). Pausing is open to anyone who may
 * approve money leaving; resuming and running a cycle are an owner's or admin's (the permission map). A sandbox's
 * cycles are capped inside `begin_cycle_run` (migration 0022); this only says which workspaces are capped.
 */

/** A `PauseError` carries a message safe to show; anything else goes to the server log under `label`. */
function pauseRefusal(error: unknown, label: string): Refused {
  if (error instanceof PauseError) return refused(error.code, error.message);
  console.error(label, error);
  return refused("failed", TRY_AGAIN);
}

export async function pauseWorkspaceAgent(actor: Actor, input: { reason: string }): Promise<CommandOutcome> {
  const refusal = gate(actor, "agent.pause");
  if (refusal) return refusal;
  try {
    await pauseAgent({ orgId: actor.orgId, actorId: actor.userId, reason: input.reason, ...provenanceOf(actor) });
  } catch (error) {
    return pauseRefusal(error, "pause agent failed");
  }
  return done("Agent paused.");
}

export async function resumeWorkspaceAgent(actor: Actor): Promise<CommandOutcome> {
  const refusal = gate(actor, "agent.resume");
  if (refusal) return refusal;
  try {
    await resumeAgent({ orgId: actor.orgId, actorId: actor.userId, ...provenanceOf(actor) });
  } catch (error) {
    return pauseRefusal(error, "resume agent failed");
  }
  runCycleSoon(cycleEventOf(actor, "agent_resumed"));
  return done("Agent resumed.");
}

export async function runWorkspaceCycle(actor: Actor): Promise<CommandOutcome<{ day: number; lines: number }>> {
  const refusal = gate(actor, "agent.run_cycle");
  if (refusal) return refusal;
  try {
    const result = await runAgentCycle({
      triggeredBy: actor.userId,
      dailyCap: actor.mode === "sandbox" ? SANDBOX_DAILY_CYCLES : undefined,
      trigger: { kind: "manual" },
    });
    return done(agentCycleSuccessMessage(result), { day: result.day, lines: result.lines.length });
  } catch (error) {
    if (error instanceof SandboxCapReachedError) return refused("sandbox_cap_reached", error.message);
    if (error instanceof AgentPausedError) return refused("agent_paused", error.message);
    if (error instanceof CycleRunningError) return refused("cycle_running", error.message);
    console.error("agent cycle failed", error);
    return refused("failed", error instanceof Error ? error.message : "The agent cycle did not complete.");
  }
}
```

- [ ] **Step 4: Rewrite the three actions in `src/app/actions/agent.ts`**

Drop the imports of `agentCycleSuccessMessage`, `runAgentCycle`, `CycleRunningError`, `AgentPausedError`,
`SANDBOX_DAILY_CYCLES`, `SandboxCapReachedError`, `pauseAgent`, `PauseError`, `resumeAgent` (keep `raiseCycleEvent` and
`revalidateOrgPages`: `setAgentBudgetAction` and the spending-limit actions still use them); add
`import { consoleActor } from "@/lib/commands/actor";`,
`import { pauseWorkspaceAgent, resumeWorkspaceAgent, runWorkspaceCycle } from "@/lib/commands/agent";`,
`import { consoleAnswer } from "./command-result";`:

```ts
export async function runAgentCycleAction(orgSlug: string): Promise<AgentActionResult> {
  const auth = await authorize(orgSlug, "agent.run_cycle");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const outcome = await runWorkspaceCycle(consoleActor(auth));
    if (!outcome.ok) return { ok: false, message: outcome.message };
    revalidateOrgPages();
    return { ok: true, message: outcome.message, day: outcome.day, lines: outcome.lines };
  });
}

export async function pauseAgentAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.pause");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await pauseWorkspaceAgent(consoleActor(auth), { reason: formString(formData, "reason") })));
}

export async function resumeAgentAction(_previous: AgentActionResult, formData: FormData): Promise<AgentActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "agent.resume");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => consoleAnswer(await resumeWorkspaceAgent(consoleActor(auth))));
}
```

`tests/access-gates.test.ts` requires `return inOrg(auth, async () =>` in each action: the two one-line bodies above
match it.

- [ ] **Step 5: Move the resume assertion in `tests/cycle-events-actions.test.ts`**

```ts
    expect(runSoonMock).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: false, kind: "agent_resumed" });
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/commands-agent.test.ts tests/agent-action.test.ts tests/cycle-events-actions.test.ts tests/access-gates.test.ts tests/pause.test.ts`
Expected: PASS. `tests/agent-action.test.ts` is unchanged and passes against the real cycle path.

- [ ] **Step 7: Commit**

```bash
git add src/lib/commands/agent.ts src/app/actions/agent.ts tests/commands-agent.test.ts tests/cycle-events-actions.test.ts
git commit -m "Pause, resume and run the agent through commands"
```

### Task 6: Adding an invoice, and the bot's Add on it

**Files:**
- Create: `src/lib/commands/invoices.ts`, `src/lib/commands/index.ts`
- Modify: `src/lib/telegram/intake.ts` (`addDraft`)
- Test: `tests/commands-invoices.test.ts`

**Interfaces:**
- Consumes: Task 1; `createInvoice(input: { actorId; invoice: InvoiceInput; document: DocumentProvenance | null; via?: "telegram" })` (unchanged).
- Produces: `addInvoice(actor, { invoice: InvoiceInput; document: DocumentProvenance | null }): Promise<CommandOutcome<{ invoiceId: string; counterpartyName: string }>>`.

- [ ] **Step 1: Write the failing test** `tests/commands-invoices.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { addInvoice } from "@/lib/commands/invoices";
import type { InvoiceInput } from "@/lib/invoices/create";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

const { mocks } = vi.hoisted(() => ({ mocks: { createInvoice: vi.fn(), runCycleSoon: vi.fn() } }));
vi.mock("@/lib/invoices/create", () => ({ createInvoice: mocks.createInvoice }));
vi.mock("@/lib/agent/cycle-soon", () => ({ runCycleSoon: mocks.runCycleSoon }));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c41";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c7";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fakeSupabase().client, orgId: ORG }), fn);
const owner = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "sandbox", surface: { kind: "telegram", linkId: "l-1" }, ...fields });

const invoice = (direction: "payable" | "receivable"): InvoiceInput =>
  ({ direction, counterpartyId: "c-1", amount: "200.00", currency: "USDC", memo: null, poReference: "PO-1", goodsReceived: true, dueDate: "2026-10-31", earlyPayDiscountPct: null, discountDeadline: null }) as unknown as InvoiceInput;

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("addInvoice", () => {
  it("adds a payable from Telegram as the bot always has, and starts the agent", async () => {
    mocks.createInvoice.mockResolvedValueOnce({ id: "inv-1", counterpartyName: "Northwind Hosting" });
    const outcome = await run(() => addInvoice(owner(), { invoice: invoice("payable"), document: null }));
    expect(outcome).toEqual({ ok: true, message: "Invoice added for Northwind Hosting.", invoiceId: "inv-1", counterpartyName: "Northwind Hosting" });
    expect(mocks.createInvoice).toHaveBeenCalledWith({ actorId: USER, invoice: invoice("payable"), document: null, via: "telegram" });
    expect(mocks.runCycleSoon).toHaveBeenCalledWith({ orgId: ORG, userId: USER, sandbox: true, kind: "invoice_added" });
  });

  it("names no surface from the console, and starts nothing for a receivable", async () => {
    mocks.createInvoice.mockResolvedValueOnce({ id: "inv-2", counterpartyName: "Acme" });
    await run(() => addInvoice(owner({ surface: { kind: "console" } }), { invoice: invoice("receivable"), document: null }));
    expect(mocks.createInvoice).toHaveBeenCalledWith({ actorId: USER, invoice: invoice("receivable"), document: null });
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("refuses a counterparty the workspace does not hold, and an approver", async () => {
    mocks.createInvoice.mockResolvedValueOnce(null);
    expect(await run(() => addInvoice(owner(), { invoice: invoice("payable"), document: null }))).toEqual({ ok: false, code: "counterparty_not_found", message: "Counterparty not found." });
    expect(await run(() => addInvoice(owner({ role: "approver" }), { invoice: invoice("payable"), document: null }))).toMatchObject({ ok: false, code: "forbidden" });
    expect(mocks.createInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.runCycleSoon).not.toHaveBeenCalled();
  });

  it("logs and answers in general words when adding fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.createInvoice.mockRejectedValueOnce(new Error("insert failed"));
    expect(await run(() => addInvoice(owner(), { invoice: invoice("payable"), document: null }))).toEqual({
      ok: false, code: "failed", message: "The invoice could not be added. Try again in a moment.",
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/commands-invoices.test.ts`
Expected: FAIL, "Failed to resolve import "@/lib/commands/invoices"".

- [ ] **Step 3: Write `src/lib/commands/invoices.ts`**

```ts
import { runCycleSoon } from "../agent/cycle-soon";
import type { DocumentProvenance } from "../invoice-document/provenance";
import { createInvoice, type InvoiceInput } from "../invoices/create";
import { cycleEventOf, type Actor } from "./actor";
import { done, refused, type CommandOutcome } from "./outcome";
import { gate } from "./policy";

/**
 * Adds an invoice as the actor (integrations design §9, Phase 0), through the one `createInvoice` the invoice form
 * uses. A payable gives the agent a decision to make, so it starts a cycle within seconds; a receivable does not. The
 * invoice form, the CSV import and the write API move onto this command once the write API's branch, which changes
 * `createInvoice`, has merged.
 */
export async function addInvoice(
  actor: Actor,
  input: { invoice: InvoiceInput; document: DocumentProvenance | null }
): Promise<CommandOutcome<{ invoiceId: string; counterpartyName: string }>> {
  const refusal = gate(actor, "invoice.add");
  if (refusal) return refusal;
  let created: Awaited<ReturnType<typeof createInvoice>>;
  try {
    created = await createInvoice({
      actorId: actor.userId,
      invoice: input.invoice,
      document: input.document,
      // The entry names the bot exactly as it always has (Telegram bot design R10).
      ...(actor.surface.kind === "telegram" ? { via: "telegram" as const } : {}),
    });
  } catch (error) {
    console.error("adding an invoice failed", actor.orgId, error instanceof Error ? error.message : "unknown error");
    return refused("failed", "The invoice could not be added. Try again in a moment.");
  }
  if (!created) return refused("counterparty_not_found", "Counterparty not found.");
  if (input.invoice.direction === "payable") runCycleSoon(cycleEventOf(actor, "invoice_added"));
  return done(`Invoice added for ${created.counterpartyName}.`, { invoiceId: created.id, counterpartyName: created.counterpartyName });
}
```

- [ ] **Step 4: Write `src/lib/commands/index.ts`**

```ts
/** One action from every surface (integrations design §8): the actor, the gate, and the commands. */
export { consoleActor, memberActor, provenanceOf, type Actor, type Surface, type SurfaceKind } from "./actor";
export { COMMAND_PERMISSIONS, SURFACE_COMMANDS, gate, ActorScopeError, type CommandName } from "./policy";
export { done, refused, TRY_AGAIN, type CommandOutcome, type Done, type Refused } from "./outcome";
export { addPayableDetails, approvePayable, rejectPayable, returnPayable } from "./payables";
export { closeMilestoneUnpaid, payMilestoneNow } from "./milestones";
export { pauseWorkspaceAgent, resumeWorkspaceAgent, runWorkspaceCycle } from "./agent";
export { addInvoice } from "./invoices";
```

- [ ] **Step 5: Move the bot's Add onto the command** in `src/lib/telegram/intake.ts`

Imports: drop `runCycleSoon` and `createInvoice`; add `import { memberActor } from "../commands/actor";`,
`import { addInvoice } from "../commands/invoices";`, `import { gate } from "../commands/policy";`. `addDraft` becomes:

```ts
/** Adds the draft as a payable, as the member (R10), through the same command every surface uses, which starts the agent's cycle. */
export async function addDraft(link: TelegramLink, tap: DraftTap, deps: IntakeDeps): Promise<"added" | "used" | "refused" | "ignored" | "failed"> {
  if (!ownTap(link, tap)) return "ignored";
  const { client, workspace } = deps;
  const actor = await memberActor(link.orgId, link.userId, { kind: "telegram", linkId: link.id });
  // Asked before the draft is claimed, so a refused tap leaves it for someone who may add it.
  if (!actor || gate(actor, "invoice.add")) {
    await client.editMessageText(tap.chatId, tap.messageId, roleRefusal(actor?.role ?? null, workspace.name));
    return "refused";
  }
  const stored = await claimDraft(link, tap.draftId, deps.now?.() ?? new Date());
  if (!stored) {
    await client.editMessageText(tap.chatId, tap.messageId, USED);
    return "used";
  }

  const parsed = invoiceInputSchema.safeParse({ direction: "payable", ...stored.draft, goodsReceived: tap.goodsReceived });
  const added = parsed.success ? await addInvoice(actor, { invoice: parsed.data, document: { ...stored.document, changed: [] } }) : null;
  if (!parsed.success || !added?.ok) {
    const reason = added && !added.ok && added.code !== "counterparty_not_found" ? escapeHtml(added.message) : null;
    await client.editMessageText(
      tap.chatId,
      tap.messageId,
      reason ?? "The invoice could not be added: its counterparty is no longer in this workspace. Add it in Vestiarion."
    );
    return "failed";
  }

  const invoice = parsed.data;
  await client.editMessageText(
    tap.chatId,
    tap.messageId,
    `Added a payable for ${escapeHtml(added.counterpartyName)}: ${escapeHtml(amountText(invoice.amount, invoice.currency))}, due ${escapeHtml(invoice.dueDate)}, ` +
      `${tap.goodsReceived ? "goods received" : "goods not received yet"}. The agent usually decides within a minute, and its decision will be sent here.`
  );
  return "added";
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/commands-invoices.test.ts tests/telegram-intake.test.ts tests/telegram-updates.test.ts`
Expected: PASS. `tests/telegram-intake.test.ts` is unchanged: the same draft claim, the same `via: "telegram"` entry,
the same `runCycleSoon` event, the same refusal for a viewer before the claim.

- [ ] **Step 7: Commit**

```bash
git add src/lib/commands/invoices.ts src/lib/commands/index.ts src/lib/telegram/intake.ts tests/commands-invoices.test.ts
git commit -m "Add the bot's invoices through the shared command"
```

### Task 7: The structural guard, the docs, and the whole suite

**Files:**
- Create: `tests/commands-gates.test.ts`
- Modify: `ARCHITECTURE.md`, `docs/superpowers/specs/2026-10-03-integrations-design.md` (status, §12)

- [ ] **Step 1: Write the structural test** `tests/commands-gates.test.ts`

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_PERMISSIONS } from "@/lib/commands/policy";

/**
 * The commands' gate, pinned as source structure, as tests/access-gates.test.ts pins the server actions': every
 * exported command checks its scope, its permission and its surface before it awaits anything, and every command the
 * policy names has exactly one function. Nothing in src/lib/commands reads a session or Next's request APIs: a surface
 * resolves its actor, and the command never asks where it is running.
 */

const DIR = path.join(process.cwd(), "src", "lib", "commands");
const SUPPORT = new Set(["actor.ts", "outcome.ts", "policy.ts", "index.ts"]);
const read = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const FILES = readdirSync(DIR).filter((name) => name.endsWith(".ts"));

function exportedAsyncFunctions(source: string): Array<{ name: string; body: string }> {
  return source.split(/\n(?=export )/).flatMap((part) => {
    const match = /^export async function (\w+)/.exec(part.trimStart());
    return match ? [{ name: match[1], body: part }] : [];
  });
}

const COMMANDS = FILES.filter((name) => !SUPPORT.has(name)).flatMap((file) =>
  exportedAsyncFunctions(read(file)).map((fn) => ({ label: `${file} ${fn.name}`, body: fn.body }))
);
const GATE = /\{\s*const refusal = gate\(actor, "([a-z_.]+)"\);\s*if \(refusal\) return refusal;/;

describe("every command", () => {
  it("covers the policy: one function per command it names", () => {
    const gated = COMMANDS.map((command) => GATE.exec(command.body)?.[1] ?? command.label);
    expect(gated.sort()).toEqual(Object.keys(COMMAND_PERMISSIONS).sort());
  });

  it.each(COMMANDS.map((command) => [command.label, command.body]))("%s gates before it awaits anything", (_label, body) => {
    const gateAt = body.search(GATE);
    expect(gateAt).toBeGreaterThan(-1);
    const firstAwait = body.indexOf("await ");
    expect(firstAwait === -1 || firstAwait > gateAt).toBe(true);
  });

  it.each(FILES)("%s reads no session and no request", (file) => {
    const source = read(file);
    expect(source).not.toMatch(/from "(?:@\/lib\/auth\/(?:authorize|session|membership)|next\/headers|next\/cache)"/);
    expect(source).not.toMatch(/from "\.\.\/auth\/(?:authorize|session|membership)"/);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/commands-gates.test.ts`
Expected: PASS (it pins what Tasks 3–6 wrote; change a command's first statement to see it fail).

- [ ] **Step 3: Document the layer in `ARCHITECTURE.md`**

After the "Approvals and the pause switch" section, add:

```markdown
## Commands: one action from every surface

A person's actions reach the domain through `src/lib/commands/`
(docs/superpowers/specs/2026-10-03-integrations-design.md), so a new surface adds an adapter rather than a second
gate. An **actor** is one member acting through one surface: `consoleActor(auth)` after the console's `authorize`, or
`memberActor(orgId, userId, surface)`, which reads the role and the workspace's mode for that action, never from a
link, a key or a button. A **command** is one function per action — `approvePayable`, `rejectPayable`,
`returnPayable`, `addPayableDetails`, `payMilestoneNow`, `closeMilestoneUnpaid`, `pauseWorkspaceAgent`,
`resumeWorkspaceAgent`, `runWorkspaceCycle`, `addInvoice` — whose first statement is `gate(actor, "<command>")`:

- the scope in force must be the actor's workspace, or it throws (`ActorScopeError`): a surface that entered one
  workspace cannot act for another's member;
- the role must hold the command's permission (`COMMAND_PERMISSIONS`, from the permission map);
- the surface must be one that may run it (`SURFACE_COMMANDS`): the console runs everything; Telegram adds invoices
  and decides nothing; the API adds records.

The command then calls the domain function as the console always has, raises what follows (the agent's next look,
`runCycleSoon`; a paid payee's notice, `sendNoticesSoon`), and returns the console's own words as
`{ ok, message, … }` or `{ ok: false, code, message, changed? }`. A decision made anywhere but the console names its
surface in its signed entry (`provenance`: `via` with `linkId` or `apiKeyId`); the console's entries carry no `via`,
as before. The console's server actions keep `authorize` first and refresh their pages (`consoleAnswer`); the
Telegram bot's **Add** builds its actor with `memberActor`. `tests/commands-gates.test.ts` holds every command to its
gate. The invoice form, the CSV import and the write API move onto `addInvoice` next.
```

- [ ] **Step 4: Update the spec's status line and §12**

Status: "review done; Phase 0 implemented on `feat/integrations` (PR #<n>); Phase 1 designed, not started." Fill §12
with the PR number once opened.

- [ ] **Step 5: Run everything**

Run: `npm run verify`
Expected: lockfile OK, typecheck clean, lint clean, every test passing.

- [ ] **Step 6: Commit**

```bash
git add tests/commands-gates.test.ts ARCHITECTURE.md docs/superpowers/specs/2026-10-03-integrations-design.md
git commit -m "Hold every command to its gate, and document the layer"
```

---

## Self-review

- Spec coverage: G1 (one gate) Tasks 1, 3–6; G2 (follow-ups in the command) Tasks 3, 5, 6; G3 (provenance) Task 2;
  G4 (surface policy) Task 1; R1–R7 Tasks 1–7; §9 Phase 0 acceptance Task 7 (`npm run verify`) and the partner's
  regression check after merge. G5–G8 are later phases by design.
- Types: `Actor`, `CommandOutcome`, `Refused.changed`, `provenanceOf` → `{ provenance? }`, `cycleEventOf` →
  `CycleEvent` are used with the same names in every task.
