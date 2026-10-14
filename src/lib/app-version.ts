import pkg from "../../package.json";

/**
 * Which build of the app is running, for a record that should say so (docs/superpowers/specs/2026-10-14-capability-and-
 * reasons-design.md R12): the deployment's git commit on Vercel, cut to 12 characters, or the package's version where
 * there is none (a local run, a test). Never empty.
 */
export function appVersion(env: Record<string, string | undefined> = process.env): string {
  const sha = env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha.slice(0, 12).toLowerCase();
  return `v${pkg.version}`;
}
