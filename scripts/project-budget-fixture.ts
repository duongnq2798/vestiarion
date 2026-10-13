/**
 * Two decisions at once never set aside the same money (docs/superpowers/specs/2026-10-13-project-budgets-design.md P4),
 * shown on a real Postgres, with real concurrent transactions: a test database cannot run two at once.
 *
 *   PROJECT_FIXTURE_DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres npm run fixture:project-budget
 *
 * The URL is a superuser's, on a throwaway server on this machine: the fixture refuses any other host, makes its own
 * database (vx_project_fixture_<random>), applies every migration to it with the roles Supabase provides, and drops it
 * at the end. It never reads `.env.local` and never touches a workspace's database.
 *
 * 1. The race. A project of 1,000.00 USDC keeps 100.00 back. Ten deciders each reserve a 200.00 bill at the same
 *    moment, each on its own connection, as the tenant role, and each holds its transaction open for a while after
 *    reserving. Exactly four fit (800.00 of the 900.00 it may set aside): four are reserved, six are over, and what is
 *    set aside never passes 900.00. The deciders after the first wait on the project's row: their wait is measured.
 * 2. The control. The same race through a check and an insert with no lock, and with 0111's check on insert turned
 *    off, sets aside more than the project may: the harness makes the race real, and the lock is what stops it.
 * 3. The release. Concurrently, one transaction pays a reserved bill while another reserves for a waiting one: the paid
 *    bill is counted once, as reserved or as paid, at every moment; once it is paid its money is paid, not reserved; a
 *    rejected bill frees its money for the bill that was over, which is then reserved.
 *
 * Exits 1 when any of it does not hold.
 */
import crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

const BASELINE = `
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator; end if;
end $$;
create schema if not exists auth;
create schema if not exists extensions;
create table if not exists auth.users (id uuid primary key, email text);
`;

const DECIDERS = 10;
const HOLD_OPEN_MS = 300;

function adminUrl(): URL {
  const raw = process.env.PROJECT_FIXTURE_DATABASE_URL;
  if (!raw) throw new Error("Set PROJECT_FIXTURE_DATABASE_URL to a superuser's URL on a throwaway Postgres on this machine.");
  const url = new URL(raw);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("The fixture runs only against a Postgres on this machine.");
  return url;
}

const failures: string[] = [];
function check(holds: boolean, what: string): void {
  console.log(`${holds ? "ok  " : "FAIL"} ${what}`);
  if (!holds) failures.push(what);
}

async function connect(url: URL): Promise<Client> {
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** A transaction as the tenant role, as PostgREST runs a request: claims set, then the role. */
async function asTenant(client: Client, orgId: string): Promise<void> {
  await client.query("begin");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "vestiarion_tenant", org_id: orgId })]);
  await client.query("set local role authenticator");
  await client.query("set local role vestiarion_tenant");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const admin = adminUrl();
  const name = `vx_project_fixture_${crypto.randomBytes(4).toString("hex")}`;
  const root = await connect(admin);
  await root.query(`create database ${name}`);
  const dbUrl = new URL(admin.toString());
  dbUrl.pathname = `/${name}`;
  const clients: Client[] = [];
  try {
    const setup = await connect(dbUrl);
    clients.push(setup);
    await setup.query(BASELINE);
    const dir = path.join(process.cwd(), "supabase", "migrations");
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
      await setup.query(readFileSync(path.join(dir, file), "utf8"));
    }
    console.log(`Applied every migration to ${name}.`);

    const one = async (sql: string, params: unknown[]) => (await setup.query<{ id: string }>(sql, params)).rows[0].id;
    const orgId = await one("insert into public.orgs (slug, name, mode) values ($1, 'Fixture', 'sandbox') returning id", [`fixture-${crypto.randomBytes(3).toString("hex")}`]);
    const vendor = await one("insert into public.counterparties (org_id, name, role) values ($1, 'Northwind Studio', 'vendor') returning id", [orgId]);
    const project = async (label: string) =>
      one("insert into public.projects (org_id, name, budget_minor, buffer_minor, idempotency_key) values ($1, $2, 100000, 10000, $3) returning id", [orgId, label, `fixture-${label}-${crypto.randomUUID()}`]);
    const bill = (projectId: string, amount: string) =>
      one("insert into public.invoices (org_id, direction, counterparty_id, amount, due_date, project_id) values ($1, 'payable', $2, $3, now(), $4) returning id", [orgId, vendor, amount, projectId]);
    // One query at a time on the setup connection.
    const bills = async (projectId: string, count: number) => {
      const ids: string[] = [];
      for (let index = 0; index < count; index += 1) ids.push(await bill(projectId, "200.00"));
      return ids;
    };
    const figures = async (projectId: string) =>
      (await setup.query<{ reserved: number; paid: number }>("select reserved_minor::int as reserved, paid_minor::int as paid from public.project_figures($1) where project_id = $2", [orgId, projectId])).rows[0];

    for (let index = 0; index < DECIDERS; index += 1) clients.push(await connect(dbUrl));
    const deciders = clients.slice(1, DECIDERS + 1);

    // 1. The race, through 0111's function.
    const raced = await project("Race");
    const raceBills = await bills(raced, DECIDERS);
    const started = Date.now();
    const answers = await Promise.all(
      deciders.map(async (client, index) => {
        await asTenant(client, orgId);
        const asked = Date.now();
        const { rows } = await client.query<{ r: { state: string } }>("select public.reserve_project_budget($1, $2, null, 'agent', null) as r", [orgId, raceBills[index]]);
        const answered = Date.now();
        await sleep(HOLD_OPEN_MS);
        await client.query("commit");
        return { state: rows[0].r.state, waitedMs: answered - asked };
      })
    );
    const reserved = answers.filter((answer) => answer.state === "reserved").length;
    const over = answers.filter((answer) => answer.state === "over").length;
    const after = await figures(raced);
    console.log(`Race: ${reserved} reserved, ${over} over, ${after.reserved / 100} USDC set aside, in ${Date.now() - started} ms; longest wait for the lock ${Math.max(...answers.map((a) => a.waitedMs))} ms.`);
    check(reserved === 4 && over === 6, "exactly the four bills the budget less its buffer holds are reserved; the other six are over");
    check(after.reserved === 80_000 && after.reserved + after.paid <= 90_000, "what is set aside never passes the budget less its buffer");
    check(answers.filter((answer) => answer.waitedMs >= HOLD_OPEN_MS * 0.8).length >= DECIDERS - 1, "every decider after the first waited on the project's row");

    // 2. The control: a check and an insert with no lock, and 0111's check on insert turned off.
    await setup.query("alter table public.project_reservations disable trigger project_reservations_within_budget");
    const naive = await project("No lock");
    const naiveBills = await bills(naive, DECIDERS);
    await Promise.all(
      deciders.map(async (client, index) => {
        await asTenant(client, orgId);
        const { rows } = await client.query<{ left: number }>(
          "select (100000 - 10000 - public.project_reserved_minor($1, $2) - public.project_paid_minor($1, $2))::int as left",
          [orgId, naive]
        );
        if (rows[0].left >= 20_000) {
          await client.query("insert into public.project_reservations (org_id, project_id, invoice_id, amount_minor, via) values ($1, $2, $3, 20000, 'agent')", [orgId, naive, naiveBills[index]]);
        }
        await sleep(HOLD_OPEN_MS);
        await client.query("commit");
      })
    );
    await setup.query("alter table public.project_reservations enable trigger project_reservations_within_budget");
    const naiveAfter = await figures(naive);
    console.log(`Control, with no lock: ${naiveAfter.reserved / 100} USDC set aside of the 900.00 USDC the project may.`);
    check(naiveAfter.reserved > 90_000, "the same race with no lock sets aside more than the project may: the race is real");

    // 3. The release, while others reserve.
    const released = await project("Release");
    const paying = await bill(released, "500.00");
    const rejecting = await bill(released, "300.00");
    const waiting = await bill(released, "350.00");
    for (const id of [paying, rejecting]) await setup.query("select public.reserve_project_budget($1, $2, null, 'agent', null)", [orgId, id]);
    const [payer, rejecter, reserver] = deciders;
    await asTenant(payer, orgId);
    await payer.query("update public.invoices set status = 'paid', paid_amount = 500 where id = $1", [paying]);
    await asTenant(reserver, orgId);
    // Reserved while the payment is not committed yet: the paid bill is still counted, once, as reserved.
    const during = (await reserver.query<{ r: { state: string; reservedMinor: number; paidMinor: number } }>("select public.reserve_project_budget($1, $2, null, 'agent', null) as r", [orgId, waiting])).rows[0].r;
    await reserver.query("commit");
    await payer.query("commit");
    check(during.state === "over" && during.reservedMinor + during.paidMinor === 80_000, "a bill being paid is counted once while its payment commits: 800.00 USDC set aside or paid, the waiting bill over");
    const paid = await figures(released);
    check(paid.paid === 50_000 && paid.reserved === 30_000, "once paid, the bill's money is paid, not reserved: 500.00 paid, 300.00 set aside");
    const reasons = (await setup.query<{ release_reason: string }>("select release_reason from public.project_reservations where invoice_id = $1", [paying])).rows;
    check(reasons.length === 1 && reasons[0].release_reason === "paid", "its reservation was released as paid, in the payment's transaction");
    await asTenant(rejecter, orgId);
    await rejecter.query("update public.invoices set status = 'rejected' where id = $1", [rejecting]);
    await rejecter.query("commit");
    const again = (await setup.query<{ r: { state: string } }>("select public.reserve_project_budget($1, $2, null, 'agent', null) as r", [orgId, waiting])).rows[0].r;
    const end = await figures(released);
    check(again.state === "reserved" && end.reserved === 35_000 && end.paid === 50_000, "a rejected bill frees its money: the bill that was over is reserved, and 850.00 of 900.00 is committed");
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
    await root.query(`drop database if exists ${name} with (force)`);
    await root.end();
  }
  if (failures.length > 0) {
    console.error(`${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("Every check held.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
