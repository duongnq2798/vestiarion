import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/components/ui/cn";
import { GROUP_TABLE_HEAD, groupRows, QUALITY_LAB_RESULTS } from "@/lib/quality-lab/results";
import { scoreWords, wrongPaymentWords } from "@/lib/quality-lab/words";

/**
 * The Quality Lab's figures on its docs page (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL8), rendered from
 * the committed results so the page never types one: the score, and each group's table of scenarios. The page's Markdown
 * view writes the same words (`MDX_TO_MARKDOWN` in src/lib/docs/markdown.ts).
 */

/** "39 of 39 scenarios right, 0 wrong payments.", as a paragraph of the page. */
export function QualityLabScore() {
  const { summary } = QUALITY_LAB_RESULTS;
  return (
    <p className="my-4 text-[1rem] leading-[1.75] text-ink-2">
      <strong className="font-semibold text-ink">{scoreWords(summary)}</strong>, {wrongPaymentWords(summary.wrongPayments)}.
    </p>
  );
}

/** One group's scenarios: what each expected, what happened, and whether it was right. */
export function QualityLabTable({ group }: { group: string }) {
  const rows = groupRows(group);
  return (
    <Table containerClassName="my-6 rounded-xl border border-line bg-surface">
      <TableHeader>
        <TableRow>
          {GROUP_TABLE_HEAD.map((head) => (
            <TableHead key={head}>{head}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([title, expected, actual, right]) => (
          <TableRow key={title}>
            <TableCell className="align-top text-ink">{title}</TableCell>
            <TableCell className="align-top text-ink-2">{expected}</TableCell>
            <TableCell className="align-top text-ink-2">{actual}</TableCell>
            <TableCell className={cn("align-top font-semibold", right === "Yes" ? "text-proof" : right === "No" ? "text-held" : "text-refused")}>{right}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
