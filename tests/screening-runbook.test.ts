import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HEALTH_CHECK_NAME, screeningCheckLogLine, type ScreeningCheck } from "@/lib/screening/check";

/**
 * The screening key's runbook (docs/self-hosting.md, "Changing the screening key"; screening health SH5) held to the
 * code: every command it gives is a package.json script, every variable it names is one the configuration reads, and
 * the page, the button, the fixed name and the log line it describes are the app's own.
 */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(path.join(ROOT, ...parts), "utf8");

const SELF_HOSTING = read("docs", "self-hosting.md");
const start = SELF_HOSTING.indexOf("### Changing the screening key");
const RUNBOOK = SELF_HOSTING.slice(start, SELF_HOSTING.indexOf("\n## ", start));
const SCRIPTS = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
const CONFIG = read("src", "lib", "config.ts");
const ADMIN_PAGE = read("src", "app", "admin", "screening", "page.tsx");

const commands = (text: string) => [...text.matchAll(/npm run ([a-z][a-z:-]*)/g)].map((match) => match[1]);

describe("the screening key's runbook", () => {
  it("is there, in five numbered steps", () => {
    expect(start).toBeGreaterThan(-1);
    expect([...RUNBOOK.matchAll(/^(\d)\. /gm)].map((match) => match[1])).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("gives only commands package.json has", () => {
    expect(commands(RUNBOOK)).toContain("screening:check");
    for (const command of [...commands(RUNBOOK), ...commands(ADMIN_PAGE)]) expect(SCRIPTS, command).toHaveProperty([command]);
  });

  it("names only variables the configuration reads", () => {
    const named = [...new Set([...RUNBOOK.matchAll(/\b((?:SCREENING|OPENSANCTIONS)_[A-Z_]*[A-Z])\b/g)].map((match) => match[1]))];
    expect(named).toEqual(expect.arrayContaining(["OPENSANCTIONS_API_KEY", "OPENSANCTIONS_API_URL", "SCREENING_API_KEY"]));
    for (const name of named) expect(CONFIG, name).toContain(`env.${name}`);
  });

  it("describes the app's own page, button, fixed name and log line", () => {
    expect(RUNBOOK).toContain("/admin/screening");
    expect(existsSync(path.join(ROOT, "src", "app", "admin", "screening", "page.tsx"))).toBe(true);
    expect(RUNBOOK).toContain("**Check now**");
    expect(read("src", "components", "admin", "ScreeningCheck.tsx")).toContain("Check now");
    expect(RUNBOOK).toContain(`"${HEALTH_CHECK_NAME}"`);
    const line = screeningCheckLogLine({ provider: "opensanctions", origin: "https://api.opensanctions.org", ok: true, httpStatus: null, ms: 1 } as ScreeningCheck);
    const fields = line.replace(/=[^ ]+/g, "=…");
    expect(fields).toBe("screening check: provider=… origin=… ok=… status=… ms=…");
    expect(RUNBOOK.replace(/\s+/g, " ")).toContain(`\`${fields}\``);
  });

  it("is where the admin page points", () => {
    expect(ADMIN_PAGE).toContain("Changing the screening key");
    expect(ADMIN_PAGE).toContain("docs/self-hosting.md");
  });
});
