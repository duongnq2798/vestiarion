/**
 * Checks that package-lock.json still describes package.json.
 *
 * `npm ci` does this too, and more strictly — but it also demands that the
 * lock list every platform-conditional optional dependency for the platform it
 * is running on. A lockfile generated on Windows cannot satisfy that on Linux:
 * npm prunes optional packages it cannot build locally (bufferutil needs
 * node-gyp), so `npm ci` on the runner fails with EUSAGE over dependencies
 * this project does not use and cannot pin from a Windows machine.
 *
 * The guarantee worth keeping is that the declared dependencies and their
 * pinned versions agree. That is platform-independent, so it is checked here
 * and CI installs with `npm install`, which honours the lock for everything it
 * does list.
 */
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const root = lock.packages?.[""] ?? {};

const problems = [];

for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
  const declared = pkg[field] ?? {};
  const locked = root[field] ?? {};
  for (const [name, range] of Object.entries(declared)) {
    if (locked[name] !== range) {
      problems.push(`${field}: ${name} is "${range}" in package.json but "${locked[name] ?? "absent"}" in the lock`);
    }
  }
  for (const name of Object.keys(locked)) {
    if (!(name in declared)) problems.push(`${field}: ${name} is in the lock but not in package.json`);
  }
}

if (lock.lockfileVersion < 3) problems.push(`lockfileVersion ${lock.lockfileVersion} is older than 3`);
if (pkg.name !== lock.name) problems.push(`name differs: ${pkg.name} vs ${lock.name}`);

if (problems.length > 0) {
  console.error("package-lock.json is out of sync with package.json:\n" + problems.map((p) => `  ${p}`).join("\n"));
  console.error("\nRun `npm install` and commit the updated lockfile.");
  process.exit(1);
}

const count = Object.keys(lock.packages ?? {}).length;
console.log(`package-lock.json agrees with package.json (${count} locked packages, lockfileVersion ${lock.lockfileVersion})`);
