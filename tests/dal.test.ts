import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { NoOrgScopeError, runWith } from "@/lib/context";
import { db, platformDb, TENANT_RPCS, TENANT_TABLES } from "@/lib/dal";
import { carriesOrg, fakeSupabase } from "./support/fake-supabase";

const ORG_A = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const ORG_B = "0b6c1c9e-4a4f-4a7e-9b1e-000000000b0b";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

/** `null` means no organization in scope (`undefined` would take the default). */
function scoped<T>(fn: () => Promise<T> | T, orgId: string | null = ORG_A) {
  const fake = fakeSupabase();
  const result = runWith({ config, db: fake.client, orgId: orgId ?? undefined }, async () => fn());
  return { fake, result };
}

describe("db() outside an organization", () => {
  it("throws before any request is made", async () => {
    const { fake, result } = scoped(() => db(), null);
    await expect(result).rejects.toThrow(NoOrgScopeError);
    expect(fake.requests).toEqual([]);
  });
});

describe("a handle's bound organization", () => {
  it("refuses to act once a nested scope enters another organization", async () => {
    // db() binds its organization when it is called, not on every use. A
    // handle kept past a nested `runWith` for another organization must
    // refuse rather than go on quietly serving the one it was created in.
    const fake = fakeSupabase();
    const result = runWith({ config, db: fake.client, orgId: ORG_A }, async () => {
      const handle = db();
      return runWith({ config, db: fake.client, orgId: ORG_B }, () => handle.from("invoices").select("*"));
    });
    await expect(result).rejects.toThrow(/belongs to a different organization/);
    expect(fake.requests).toEqual([]);
  });
});

describe("db() reads", () => {
  it.each(TENANT_TABLES)("filters %s by the organization", async (table) => {
    const { fake, result } = scoped(async () => db().from(table).select("*"));
    await result;
    expect(fake.requests).toHaveLength(1);
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });

  it("keeps the organization on a lookup by id, so another organization's id finds nothing", async () => {
    const { fake, result } = scoped(async () => db().from("counterparties").select("id, name").eq("id", "someone-elses-id").maybeSingle());
    await result;
    expect(fake.requests[0].params.get("org_id")).toBe(`eq.${ORG_A}`);
    expect(fake.requests[0].params.get("id")).toBe("eq.someone-elses-id");
  });

  it("keeps the organization on a head-only count", async () => {
    const { fake, result } = scoped(async () => db().from("ledger_entries").select("*", { count: "exact", head: true }));
    await result;
    expect(fake.requests[0].method).toBe("HEAD");
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });
});

describe("db() writes", () => {
  it("stamps every inserted row", async () => {
    const { fake, result } = scoped(async () => db().from("invoices").insert([{ amount: "1" }, { amount: "2" }]));
    await result;
    expect(fake.requests[0].body).toEqual([{ amount: "1", org_id: ORG_A }, { amount: "2", org_id: ORG_A }]);
  });

  it("stamps an upsert", async () => {
    const { fake, result } = scoped(async () => db().from("payment_intents").upsert({ idempotency_key: "k" }, { onConflict: "idempotency_key", ignoreDuplicates: true }));
    await result;
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });

  it("refuses a row that already names another organization", async () => {
    const { fake, result } = scoped(async () => db().from("invoices").insert({ amount: "1", org_id: ORG_B }));
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a foreign row inside an array insert", async () => {
    const { fake, result } = scoped(async () => db().from("invoices").insert([{ amount: "1" }, { amount: "2", org_id: ORG_B }]));
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a foreign row in an upsert", async () => {
    const { fake, result } = scoped(async () =>
      db().from("payment_intents").upsert({ idempotency_key: "k", org_id: ORG_B }, { onConflict: "org_id" })
    );
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a row with org_id explicitly null", async () => {
    const { fake, result } = scoped(async () => db().from("invoices").insert({ amount: "1", org_id: null }));
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });

  it("confines an update to the organization and refuses to move a row out of it", async () => {
    const ok = scoped(async () => db().from("invoices").update({ status: "paid" }).eq("id", "i1"));
    await ok.result;
    expect(ok.fake.requests[0].method).toBe("PATCH");
    expect(ok.fake.requests[0].params.get("org_id")).toBe(`eq.${ORG_A}`);
    expect(ok.fake.requests[0].body).toEqual({ status: "paid" });

    const moved = scoped(async () => db().from("invoices").update({ org_id: ORG_B }).eq("id", "i1"));
    await expect(moved.result).rejects.toThrow(/names a different organization/);
    expect(moved.fake.requests).toEqual([]);
  });

  it("confines a delete to the organization", async () => {
    const { fake, result } = scoped(async () => db().from("forecasts").delete().eq("id", "f1"));
    await result;
    expect(fake.requests[0].method).toBe("DELETE");
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
  });
});

describe("db() upserts that could update a row (R9)", () => {
  it("refuses a merge upsert with no onConflict named", async () => {
    const { fake, result } = scoped(async () => db().from("counterparties").upsert({ name: "Acme" }));
    await expect(result).rejects.toThrow(/must name org_id in onConflict/);
    expect(fake.requests).toEqual([]);
  });

  it("refuses a merge upsert whose onConflict does not include org_id", async () => {
    const { fake, result } = scoped(async () =>
      db().from("payment_intents").upsert({ idempotency_key: "k" }, { onConflict: "idempotency_key" })
    );
    await expect(result).rejects.toThrow(/must name org_id in onConflict/);
    expect(fake.requests).toEqual([]);
  });

  it("accepts a merge upsert whose onConflict includes org_id", async () => {
    const { fake, result } = scoped(async () => db().from("sim_clock").upsert({ current_day: 0 }, { onConflict: "org_id" }));
    await result;
    expect(carriesOrg(fake.requests[0], ORG_A)).toBe(true);
    expect(fake.requests[0].params.get("on_conflict")).toBe("org_id");
  });
});

describe("db() RPCs", () => {
  it.each(TENANT_RPCS)("passes the organization to %s", async (rpc) => {
    const { fake, result } = scoped(async () => db().rpc(rpc, { some: "arg" }));
    await result;
    expect(fake.requests[0].path).toBe(`/rest/v1/rpc/${rpc}`);
    expect(fake.requests[0].body).toEqual({ some: "arg", p_org_id: ORG_A });
  });

  it("does not let a caller pass a different organization", async () => {
    const { fake, result } = scoped(async () => db().rpc("advance_sim_day", { p_org_id: ORG_B }));
    await expect(result).rejects.toThrow(/names a different organization/);
    expect(fake.requests).toEqual([]);
  });

  it("refuses an unknown RPC name", async () => {
    const { fake, result } = scoped(async () => db().rpc("drop_everything" as never));
    await expect(result).rejects.toThrow(/drop_everything is not a tenant function/);
    expect(fake.requests).toEqual([]);
  });
});

describe("the table boundary", () => {
  it("keeps platform tables out of db()", async () => {
    const { result } = scoped(async () => db().from("orgs" as never).select("*"));
    await expect(result).rejects.toThrow(/orgs is not a tenant table/);
  });

  it("keeps tenant tables out of platformDb()", async () => {
    const { result } = scoped(async () => platformDb().from("invoices" as never).select("*"), null);
    await expect(result).rejects.toThrow(/invoices is not a platform table/);
  });

  it("lets platformDb() read platform tables without an organization", async () => {
    const { fake, result } = scoped(async () => platformDb().from("memberships").select("role"), null);
    await result;
    expect(fake.requests[0].path).toBe("/rest/v1/memberships");
  });
});
