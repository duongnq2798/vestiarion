import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { cn } from "@/components/ui/cn";
import { GROUP_TABLE_HEAD, groupRows, QUALITY_LAB_RESULTS } from "@/lib/quality-lab/results";
import type { ShadowReplayResults } from "@/lib/quality-lab/shadow-replay";
import { decisionDay, QUALITY_LAB_SHADOW_RESULTS, SHADOW_NOTES_HEAD, SHADOW_TABLE_HEAD, shadowNotes, shadowRows } from "@/lib/quality-lab/shadow-results";
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
 * Every replayed decision: its answer, the verdict, what code did then and now, and its class in a few words, then under
 * the table each distinct reason once, numbered as the results name them (SR11). The result's colour comes from its
 * fields, never its words: a wrong payment is refused whatever its class. Six columns fit the page's column on a laptop
 * only with tighter cells, and with the decision's id and day free to stand on two lines (each kept whole: an id would
 * break at its hyphen); a phone scrolls the table inside its frame.
 */
export function ShadowReplayTable({ results = QUALITY_LAB_SHADOW_RESULTS }: { results?: ShadowReplayResults }) {
  const rows = shadowRows(results);
  const notes = shadowNotes(results);
  const cell = "px-3 align-top";
  return (
    <>
      <Table containerClassName="my-6 rounded-xl border border-line bg-surface">
        <TableHeader>
          <TableRow>
            {SHADOW_TABLE_HEAD.map((head) => (
              <TableHead key={head} className="px-3">
                {head}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.decisions.map((decision, index) => {
            const [, answer, verdict, then, now, result] = rows[index];
            return (
              <TableRow key={decision.id}>
                <TableCell className={cn(cell, "text-ink")}>
                  <span className="whitespace-nowrap">{decision.id},</span> <span className="whitespace-nowrap">{decisionDay(decision.day)}</span>
                </TableCell>
                <TableCell className={cn(cell, "text-ink-2")}>{answer}</TableCell>
                <TableCell className={cn(cell, "text-ink-2")}>{verdict}</TableCell>
                <TableCell className={cn(cell, "text-ink-2")}>{then}</TableCell>
                <TableCell className={cn(cell, "text-ink-2")}>{now}</TableCell>
                <TableCell className={cn(cell, decision.wrongPayment ? "font-semibold text-refused" : decision.class === "same" ? "text-ink-2" : "text-held")}>{result}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {notes.length > 0 ? (
        <div className="-mt-2 mb-6">
          <p className="text-sm font-semibold text-ink">{SHADOW_NOTES_HEAD}</p>
          <ol className="mt-2 list-decimal space-y-2 pl-6 text-sm leading-[1.6] text-ink-2 marker:font-mono marker:text-ink-3">
            {notes.map((note) => (
              <li key={note.number} className="pl-1 [overflow-wrap:anywhere]">
                <span className="text-ink">{note.decisions.join(", ")}:</span> {note.reason}
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </>
  );
}
