import { isValidSlug } from "../../src/lib/auth/org-paths";

/** Scripts that touch tenant data are told which organization; nothing defaults. */
export function orgSlugFromArgv(argv: string[], usage: string): string {
  const slug = argv.find((arg) => !arg.startsWith("--"));
  if (!slug) throw new Error(`Usage: ${usage}`);
  if (!isValidSlug(slug)) throw new Error(`${slug} is not a valid organization slug`);
  return slug;
}
