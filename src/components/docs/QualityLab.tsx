import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/components/ui/cn";
import { GROUP_TABLE_HEAD, groupRows, QUALITY_LAB_RESULTS } from "@/lib/quality-lab/results";
import type { ShadowReplayResults } from "@/lib/quality-lab/shadow-replay";
import { QUALITY_LAB_SHADOW_RESULTS, SHADOW_TABLE_HEAD, shadowRows } from "@/lib/quality-lab/shadow-results";
import { scoreWords, shadowReplayWords, wrongPaymentWords } from "@/lib/quality-lab/words";

/**
 * The Quality Lab's figures on its docs page (docs/superpowers/specs/2026-10-26-quality-lab-design.md QL8), rendered from
 * the committed results so the page never types one: the score, and each group's table of scenarios. The page's Markdown
 * view writes the same words (`MDX_TO_MARKDOWN` in src/lib/docs/markdown.ts). And the replay of the team's shadow-mode
 * decisions (docs/superpowers/specs/2026-10-26-quality-lab-shadow-replay-design.md SR11): its line, and one row per
 * decision.
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

/** "46 real decisions from the team's own shadow-mode workspaces, replayed through today's code: ...", as a paragraph. */
export function ShadowReplaySummary() {
  return <p className="my-4 text-[1rem] leading-[1.75] text-ink-2">{shadowReplayWords(QUALITY_LAB_SHADOW_RESULTS.summary)}</p>;
}

/**
 * Every replayed decision: its answer, the verdict, what code did then and now, and its class with the reason. The
 * result's colour comes from its fields, never its words: a wrong payment is refused whatever its class.
 */
export function ShadowReplayTable({ results = QUALITY_LAB_SHADOW_RESULTS }: { results?: ShadowReplayResults }) {
  const rows = shadowRows(results);
  return (
    <Table containerClassName="my-6 rounded-xl border border-line bg-surface">
      <TableHeader>
        <TableRow>
          {SHADOW_TABLE_HEAD.map((head) => (
            <TableHead key={head}>{head}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {results.decisions.map((decision, index) => {
          const [label, answer, verdict, then, now, result] = rows[index];
          return (
            <TableRow key={decision.id}>
              <TableCell className="align-top whitespace-nowrap text-ink">{label}</TableCell>
              <TableCell className="align-top text-ink-2">{answer}</TableCell>
              <TableCell className="align-top text-ink-2">{verdict}</TableCell>
              <TableCell className="align-top text-ink-2">{then}</TableCell>
              <TableCell className="align-top text-ink-2">{now}</TableCell>
              <TableCell className={cn("align-top", decision.wrongPayment ? "font-semibold text-refused" : decision.class === "same" ? "text-ink-2" : "text-held")}>{result}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
