import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The jobs that must run on time are scheduled by Supabase Cron in the production database, from
 * `supabase/cron/watches.sql`. GitHub Actions started their 5- and 10-minute schedules only a few times a day: on
 * 2026-10-06 the transfer watch had not once run on schedule 2½ hours after it merged, and the FX watch had run 4 times
 * in 26 hours. The agent's six-hourly tick followed on 2026-10-07: GitHub ran it at 00:01, 06:16, 13:21 and 22:38 UTC
 * the day before and not at all after midnight, so the day's invoices of daily recurring payments, made by the first
 * cycle of their due day, waited until an invoice added started a cycle at 04:06. Their workflows stay, for a manual
 * run. The file is run by hand in the SQL editor, so these pin what it schedules, that it holds no secret, and that it
 * is not a migration.
 */

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
const SQL_FILE = "supabase/cron/watches.sql";
const sql = existsSync(path.join(process.cwd(), SQL_FILE)) ? read(SQL_FILE) : "";
const statements = sql.replace(/^\s*--.*$/gm, "");

const JOBS = [
  { name: "vestiarion-transfer-watch", schedule: "*/5 * * * *", route: "/api/agent/transfer-watch", source: "src/app/api/agent/transfer-watch/route.ts", workflow: "transfer-watch.yml" },
  { name: "vestiarion-fx-watch", schedule: "*/5 * * * *", route: "/api/agent/fx-watch", source: "src/app/api/agent/fx-watch/route.ts", workflow: "fx-watch.yml" },
  { name: "vestiarion-webhooks", schedule: "*/10 * * * *", route: "/api/platform/webhooks", source: "src/app/api/platform/webhooks/route.ts", workflow: "webhooks.yml" },
  // At 17 minutes past every sixth hour, as GitHub's schedule was meant to run it.
  { name: "vestiarion-agent-tick", schedule: "17 */6 * * *", route: "/api/agent/tick", source: "src/app/api/agent/tick/route.ts", workflow: "agent-cycle.yml" },
] as const;

/** The schedule and SQL of a job, from its `cron.schedule(name, schedule, $$ … $$)`; undefined when the file has none. */
function scheduled(name: string): { schedule: string; command: string } | undefined {
  const match = new RegExp(`cron\\.schedule\\('${name}', '([^']+)', \\$\\$([\\s\\S]*?)\\$\\$\\);`).exec(statements);
  return match ? { schedule: match[1], command: match[2] } : undefined;
}

const maxDurationOf = (source: string) => Number(/export const maxDuration = (\d+);/.exec(read(source))?.[1]);

describe("supabase/cron/watches.sql", () => {
  it.each(JOBS)("schedules $name at '$schedule', posting to $route on the production origin", ({ name, schedule, route }) => {
    const job = scheduled(name);
    expect(job?.schedule).toBe(schedule);
    expect(job?.command).toContain("select net.http_post(");
    expect(job?.command).toContain(`url := 'https://www.vestiarion.xyz${route}'`);
  });

  it("schedules nothing else", () => {
    expect(statements.match(/cron\.schedule\(/g) ?? []).toHaveLength(JOBS.length);
  });

  it.each(JOBS)("reads the agent's token from Vault on each of $name's runs", ({ name }) => {
    expect(scheduled(name)?.command).toMatch(
      /'Authorization', 'Bearer ' \|\| \(\s*select decrypted_secret from vault\.decrypted_secrets\s+where name = 'agent_api_token'\)/
    );
  });

  it("holds no token of its own", () => {
    expect(sql).not.toMatch(/Bearer [A-Za-z0-9._~+/-]{8,}/);
  });

  it.each(JOBS)("waits for $route as long as the route may run", ({ name, source }) => {
    const timeout = Number(/timeout_milliseconds := (\d+)/.exec(scheduled(name)?.command ?? "")?.[1]);
    expect(timeout).toBeGreaterThan(maxDurationOf(source) * 1000);
  });

  it("ends a transfer watch within half its period, so two runs never tell the same payment", () => {
    // pg_net posts without waiting for the last answer, and the watch reads which attempts were told before telling the
    // rest: the route's own limit is what keeps one run from overlapping the next, as the workflow's concurrency did.
    expect(maxDurationOf("src/app/api/agent/transfer-watch/route.ts") * 2).toBeLessThanOrEqual(5 * 60);
  });

  it("is not a migration, and no migration schedules a job", () => {
    for (const file of readdirSync(path.join(process.cwd(), "supabase/migrations"))) {
      expect(read(`supabase/migrations/${file}`), file).not.toContain("cron.schedule");
    }
  });
});

describe("GitHub's schedules", () => {
  it.each(JOBS)("leaves $workflow as $name's manual run", ({ workflow, route }) => {
    const text = read(`.github/workflows/${workflow}`);
    expect(text).toContain("workflow_dispatch:");
    expect(text).not.toContain("schedule:");
    expect(text).toContain(`"\${VESTIARION_URL%/}${route}"`);
  });

  it("keeps only jobs that can wait hours, at most one run an hour", () => {
    for (const file of readdirSync(path.join(process.cwd(), ".github/workflows"))) {
      for (const [, cron] of read(`.github/workflows/${file}`).matchAll(/- cron: "([^"]+)"/g)) {
        expect(cron.split(" ")[0], `${file}: ${cron}`).toMatch(/^\d+$/);
      }
    }
  });
});
