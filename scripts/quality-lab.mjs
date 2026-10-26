// Runs the Quality Lab and writes its results (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL6, and
// docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR9): tests/quality-lab.test.ts and
// tests/quality-lab-shadow.test.ts with QUALITY_LAB_WRITE=1, which write src/lib/data/quality-lab.json and
// src/lib/data/quality-lab-shadow.json from the run instead of comparing them. Commit both: each test fails while its
// committed results are not the run's.
//
//   npm run quality-lab
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// Through a shell, so `npx` resolves to npx.cmd on Windows too.
const child = spawn("npx vitest run tests/quality-lab.test.ts tests/quality-lab-shadow.test.ts", {
  cwd: root,
  shell: true,
  stdio: "inherit",
  env: { ...process.env, QUALITY_LAB_WRITE: "1" },
});
child.on("exit", (code) => {
  if (code === 0) console.log("wrote src/lib/data/quality-lab.json and src/lib/data/quality-lab-shadow.json");
  process.exit(code ?? 1);
});
