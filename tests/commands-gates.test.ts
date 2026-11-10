import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_PERMISSIONS } from "@/lib/commands/policy";

/**
 * The commands' gate, pinned as source structure, as tests/access-gates.test.ts pins the server actions': every
 * exported command checks its scope, its permission and its surface before it awaits anything, and every command the
 * policy names has exactly one function, but for the five `milestone.*_issue` names, which have one for a Linear issue
 * and one for a Jira issue (Jira acceptance JR6). Nothing in src/lib/commands reads a session or Next's request APIs: a
 * surface resolves its actor, and a command never asks where it is running.
 */

const DIR = path.join(process.cwd(), "src", "lib", "commands");
const SUPPORT = new Set(["actor.ts", "outcome.ts", "policy.ts", "index.ts", "chat-decisions.ts"]);
const read = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const FILES = readdirSync(DIR).filter((name) => name.endsWith(".ts"));

/** Each top-level `export async function`, with its text up to the next top-level export. */
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

/** The names Linear's and Jira's commands share: one function in `linear.ts` and one in `jira.ts` for each. */
const ISSUE_COMMANDS = ["milestone.link_issue", "milestone.unlink_issue", "milestone.set_issue_criteria", "milestone.accept_issue", "milestone.check_issue"];

describe("every command", () => {
  it("covers the policy: one function per command it names, and one per tool for an issue's (Jira acceptance JR6)", () => {
    const gated = COMMANDS.map((command) => GATE.exec(command.body)?.[1] ?? command.label);
    expect(gated.sort()).toEqual([...Object.keys(COMMAND_PERMISSIONS), ...ISSUE_COMMANDS].sort());
    for (const file of ["linear.ts", "jira.ts"]) {
      const names = exportedAsyncFunctions(read(file)).map((fn) => GATE.exec(fn.body)?.[1]);
      expect(names.sort(), file).toEqual([...ISSUE_COMMANDS].sort());
    }
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
