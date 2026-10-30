"use client";

import { ChevronRight } from "lucide-react";
import { Disclosure } from "@/components/ui/Disclosure";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/Table";

/** One reading in a chart's table: its words, or a value cut short for reading with the whole of it in the title. */
export type Reading = string | number | { text: string; title: string };

/**
 * A chart's every reading, folded under it: newest first, in a frame of its own height that scrolls under a
 * header that stays, so opening a table of fifty cycles never stretches the page or the card beside it.
 *
 * A client component given the readings as plain values: a table of 120 cycles is a thousand cells, and drawn on the
 * server each one was sent twice, as HTML and again as markup for React to hydrate. Each cell's style is set once on
 * the table for the same reason, rather than on every cell.
 */
export function DetailsTable({ summary, headers, rows }: { summary: string; headers: string[]; rows: Reading[][] }) {
  const newestFirst = [...rows].reverse();
  return (
    <Disclosure
      variant="bare"
      className="mt-4 border-t border-line pt-3"
      summaryClassName="w-fit"
      contentClassName="mt-3"
      summary={
        <span className="inline-flex items-center gap-1 text-xs font-medium text-agent transition-colors duration-150 ease-standard hover:underline">
          <ChevronRight aria-hidden className="size-3.5 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
          {summary}
        </span>
      }
    >
      <p className="mb-2 text-xs text-ink-3">
        {rows.length} {rows.length === 1 ? "row" : "rows"}, newest first.
      </p>
      <Table
        label={summary}
        className="min-w-[34rem] text-xs [&_td]:whitespace-nowrap [&_td]:px-2 [&_td]:py-2 [&_td]:align-middle [&_td]:tabular-nums [&_td]:text-ink-2"
        containerClassName="max-h-80 overflow-auto rounded-lg border border-line"
      >
        <TableHeader>
          <TableRow>
            {headers.map((header) => (
              <TableHead key={header} className="sticky top-0 z-10 bg-surface px-2 py-2">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {newestFirst.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{typeof cell === "object" ? <span title={cell.title}>{cell.text}</span> : cell}</td>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Disclosure>
  );
}
