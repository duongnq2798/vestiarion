import { cn } from "@/components/ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { STATUS_FOR, type ApiErrorCode } from "@/lib/api/contract";
import { ERROR_MEANINGS } from "@/lib/docs/reference";
import { CODE_CLASS, InlineText } from "./InlineText";

/** The errors an operation can answer: each code, its HTTP status, and when it happens. */
export function ErrorTable({ codes }: { codes: readonly ApiErrorCode[] }) {
  return (
    <Table label="Errors" containerClassName="my-6 rounded-xl border border-line bg-surface">
      <TableHeader>
        <TableRow>
          <TableHead>Status</TableHead>
          <TableHead>Code</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {codes.map((code) => (
          <TableRow key={code}>
            <TableCell className="align-top font-mono text-[0.8125rem] text-ink">{STATUS_FOR[code]}</TableCell>
            <TableCell className="align-top">
              <code className={cn(CODE_CLASS, "whitespace-nowrap [overflow-wrap:normal]")}>{code}</code>
            </TableCell>
            <TableCell className="min-w-64 align-top leading-6 text-ink-2">
              <InlineText text={ERROR_MEANINGS[code]} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
