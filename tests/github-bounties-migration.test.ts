import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, asRole, asServiceRole, asTenant, createDatabase, createOrg } from "./support/pglite";

/**
 * Migration 0072 (docs/superpowers/specs/2026-10-04-github-bounties-design.md B6, B7): the bounty a maintainer attached
 * to a pull request, one per pull request and per comment, pointing at its own workspace's counterparty and milestone,
 * and closed to every role but the service role.
 */

let db: PGlite;
let orgA: string;
let orgB: string;
let counterpartyA: string;
let milestoneA: string;
let counterpartyB: string;

const newCounterparty = async (orgId: string, name: string) =>
  (
    await asServiceRole(db, (tx) =>
      tx.query<{ id: string }>("insert into public.counterparties (org_id, name, role) values ($1, $2, 'contractor') returning id", [orgId, name])
    )
  ).rows[0].id;

const newMilestone = async (orgId: string, contractorId: string) =>
  (
    await asServiceRole(db, (tx) =>
      tx.query<{ id: string }>(
        "insert into public.milestones (org_id, contractor_id, title, amount, status) values ($1, $2, 'PR #7: fix', 5, 'pending') returning id",
        [orgId, contractorId]
      )
    )
  ).rows[0].id;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  orgA = await createOrg(db, "bounties-a");
  orgB = await createOrg(db, "bounties-b");
  counterpartyA = await newCounterparty(orgA, "octocat (GitHub)");
  milestoneA = await newMilestone(orgA, counterpartyA);
  counterpartyB = await newCounterparty(orgB, "octocat (GitHub)");
}, 60_000);

afterAll(async () => {
  await db.close();
});

let nextComment = 1000;
const insert = (fields: Partial<Record<string, unknown>> = {}) => {
  const row = {
    org_id: orgA,
    installation_id: 42,
    repository: "acme/widgets",
    pull_number: 7,
    pull_url: "https://github.com/acme/widgets/pull/7",
    author_login: "octocat",
    counterparty_id: counterpartyA,
    milestone_id: milestoneA,
    amount: 5,
    attached_by_login: "maintainer-1",
    comment_id: nextComment++,
    comment_url: "https://github.com/acme/widgets/pull/7#issuecomment-1",
    ...fields,
  };
  return asServiceRole(db, (tx) =>
    tx.query(
      `insert into public.github_bounties (org_id, installation_id, repository, pull_number, pull_url, author_login, counterparty_id, milestone_id,
         amount, attached_by_login, comment_id, comment_url) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [row.org_id, row.installation_id, row.repository, row.pull_number, row.pull_url, row.author_login, row.counterparty_id, row.milestone_id, row.amount, row.attached_by_login, row.comment_id, row.comment_url]
    )
  );
};

describe("github_bounties", () => {
  it("keeps one bounty per pull request in a workspace (B6)", async () => {
    await insert();
    await expect(insert()).rejects.toThrow(/github_bounties_pull_key/);
  });

  it("takes each comment once, so a redelivered comment attaches nothing twice (B6)", async () => {
    await expect(insert({ pull_number: 8, comment_id: 1000 })).rejects.toThrow(/github_bounties_comment_key/);
  });

  it("points only at its own workspace's counterparty and milestone", async () => {
    await expect(insert({ pull_number: 9, counterparty_id: counterpartyB })).rejects.toThrow(/github_bounties_counterparty_fkey/);
    await expect(insert({ org_id: orgB, pull_number: 9, counterparty_id: counterpartyB })).rejects.toThrow(/github_bounties_milestone_fkey/);
  });

  it.each([
    ["an amount that is not above zero", { pull_number: 10, amount: 0 }, /github_bounties_amount_check/],
    ["a repository that is not owner/name in lower case", { pull_number: 11, repository: "Acme/Widgets" }, /github_bounties_repository_check/],
    ["a pull request number below one", { pull_number: 0 }, /github_bounties_pull_number_check/],
    ["a link off GitHub", { pull_number: 12, pull_url: "https://example.com/acme/widgets/pull/12" }, /github_bounties_pull_url_check/],
    ["a login GitHub would not give", { pull_number: 13, author_login: "-octocat" }, /github_bounties_author_login_check/],
  ])("refuses %s", async (_label, fields, error) => {
    await expect(insert(fields)).rejects.toThrow(error);
  });

  it("is closed to the browser roles and to the tenant: only the service role reads it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(asRole(db, role, (tx) => tx.query("select * from public.github_bounties"))).rejects.toThrow(/permission denied/);
    }
    await expect(asTenant(db, orgA, (tx) => tx.query("select * from public.github_bounties"))).rejects.toThrow(/permission denied/);
  });

  // A workspace's deletion removes it as its other rows: tests/delete-org-migration.test.ts seeds one.
  it("goes with its milestone, and with its counterparty", async () => {
    const orgC = await createOrg(db, "bounties-c");
    const counterpartyC = await newCounterparty(orgC, "hubot (GitHub)");
    const milestoneC = await newMilestone(orgC, counterpartyC);
    await insert({ org_id: orgC, counterparty_id: counterpartyC, milestone_id: milestoneC, pull_number: 20 });
    await asServiceRole(db, (tx) => tx.query("delete from public.milestones where id = $1", [milestoneC]));
    const afterMilestone = await asServiceRole(db, (tx) => tx.query("select 1 from public.github_bounties where org_id = $1", [orgC]));
    expect(afterMilestone.rows).toHaveLength(0);

    const milestoneD = await newMilestone(orgC, counterpartyC);
    await insert({ org_id: orgC, counterparty_id: counterpartyC, milestone_id: milestoneD, pull_number: 21 });
    await asServiceRole(db, (tx) => tx.query("delete from public.milestones where id = $1", [milestoneD]));
    await insert({ org_id: orgC, counterparty_id: counterpartyC, milestone_id: await newMilestone(orgC, counterpartyC), pull_number: 22 });
    await asServiceRole(db, (tx) => tx.query("delete from public.milestones where org_id = $1", [orgC]));
    await asServiceRole(db, (tx) => tx.query("delete from public.counterparties where id = $1", [counterpartyC]));
    const afterCounterparty = await asServiceRole(db, (tx) => tx.query("select 1 from public.github_bounties where org_id = $1", [orgC]));
    expect(afterCounterparty.rows).toHaveLength(0);
  });
});
