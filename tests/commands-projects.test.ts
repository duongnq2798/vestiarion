import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { COMMAND_PERMISSIONS, SURFACE_COMMANDS } from "@/lib/commands/policy";
import { addProject, assignToProjectCommand, changeProjectCommand } from "@/lib/commands/projects";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Who may make, change and fill a project (docs/superpowers/specs/2026-10-13-project-budgets-design.md P1-P3): an owner
 * or admin, from the console only. A project's budget is a control on what the agent sets aside (`agent.budget`), and
 * putting a bill in a project, or taking it out, moves it under or out of that control (`records.write`): neither is an
 * approver's, an accountant's or a viewer's. The gate refuses before anything is read.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b37";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b3";
const PROJECT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b4";
const BILL = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000b5";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const actor = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "owner", mode: "live", surface: { kind: "console" }, ...fields });
const DRAFT = { name: "Website rebuild", budgetMinor: 100_000, bufferMinor: 0 };

describe("who may make, change and fill a project", () => {
  it("is an owner's or admin's, from the console only", () => {
    expect(COMMAND_PERMISSIONS["project.create"]).toBe("agent.budget");
    expect(COMMAND_PERMISSIONS["project.change"]).toBe("agent.budget");
    expect(COMMAND_PERMISSIONS["project.assign"]).toBe("records.write");
    for (const surface of ["api", "slack", "telegram", "github"] as const) {
      for (const command of ["project.create", "project.change", "project.assign"] as const) expect(SURFACE_COMMANDS[surface], `${surface} ${command}`).not.toContain(command);
    }
  });

  it.each(["approver", "accountant", "viewer"] as const)("refuses an %s every project command, before anything is read", async (role) => {
    const fake = fakeSupabase();
    const outcomes = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), async () => [
      await addProject(actor({ role }), { draft: DRAFT, idempotencyKey: "project-key-1" }),
      await changeProjectCommand(actor({ role }), { projectId: PROJECT, change: { kind: "figures", draft: DRAFT } }),
      await assignToProjectCommand(actor({ role }), { subject: { kind: "bill", id: BILL }, projectId: PROJECT }),
      await assignToProjectCommand(actor({ role }), { subject: { kind: "bill", id: BILL }, projectId: null }),
    ]);
    for (const outcome of outcomes) expect(outcome).toMatchObject({ ok: false, code: "forbidden" });
    expect(fake.requests).toHaveLength(0);
  });
});
