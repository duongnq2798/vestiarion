/**
 * Which migrations `npm run db:migrate` applies. `--through <prefix>` stops
 * after one file, so that an additive migration can go live before the code
 * that needs it, and a contracting one only after that code is deployed.
 */
export function selectMigrations(files: string[], through: string | undefined): string[] {
  const sorted = [...files].sort();
  if (!through) return sorted;
  const matches = sorted.filter((file) => file.startsWith(through));
  if (matches.length === 0) throw new Error(`no migration matches --through ${through}`);
  if (matches.length > 1) throw new Error(`--through ${through} matches more than one migration: ${matches.join(", ")}`);
  return sorted.slice(0, sorted.indexOf(matches[0]) + 1);
}
