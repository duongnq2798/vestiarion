import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDatabase, createOrg, seedOrgRows } from "./support/pglite";

/**
 * Migration 0060 (review every match R2): a counterparty keeps every undismissed match of its latest live
 * screening as a JSON array of 1 to 25 entries, or null.
 */

let db: PGlite;
let counterpartyId: string;

beforeAll(async () => {
  db = await createDatabase();
  await applyMigrations(db);
  const orgId = await createOrg(db, "matches-co");
  counterpartyId = (await seedOrgRows(db, orgId, "matches")).counterpartyId;
}, 60_000);

afterAll(async () => {
  await db.close();
});

const keep = (value: unknown) => db.query("update public.counterparties set risk_matches = $2::jsonb where id = $1", [counterpartyId, value === null ? null : JSON.stringify(value)]);

describe("counterparties.risk_matches", () => {
  it("keeps a list of matches, or none", async () => {
    await keep([{ id: "Q6840161", caption: "Tan Guoqiang", score: 0.909, topics: ["role.pep"] }]);
    const row = (await db.query<{ risk_matches: unknown }>("select risk_matches from public.counterparties where id = $1", [counterpartyId])).rows[0];
    expect(row.risk_matches).toEqual([{ id: "Q6840161", caption: "Tan Guoqiang", score: 0.909, topics: ["role.pep"] }]);
    await keep(null);
  });

  it("refuses anything but a list of 1 to 25", async () => {
    for (const bad of [[], { id: "x" }, Array.from({ length: 26 }, (_, i) => ({ id: `Q${i}` }))]) {
      await expect(keep(bad), JSON.stringify(bad).slice(0, 40)).rejects.toThrow(/counterparties_risk_matches_check/);
    }
  });
});
