import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import type { DocParam } from "@/lib/api/openapi";
import { CODE_CLASS, InlineText } from "./InlineText";

const NONE = <span className="text-ink-3">—</span>;

/** The values a parameter accepts beyond its type: its enum, or its range. */
function allowedValues(param: DocParam): ReactNode {
  if (param.enum) {
    return (
      <span className="flex flex-wrap gap-1.5">
        {param.enum.map((value) => (
          <code key={value} className={cn(CODE_CLASS, "whitespace-nowrap [overflow-wrap:normal]")}>
            {value}
          </code>
        ))}
      </span>
    );
  }
  if (param.minimum !== undefined || param.maximum !== undefined) {
    if (param.minimum !== undefined && param.maximum !== undefined) return `${param.minimum} to ${param.maximum}`;
    return param.minimum !== undefined ? `at least ${param.minimum}` : `at most ${param.maximum}`;
  }
  return NONE;
}

/**
 * An operation's path and query parameters, one row each. The table scrolls
 * sideways inside its own frame on a narrow screen.
 */
export function ParamTable({ params }: { params: DocParam[] }) {
  if (params.length === 0) return <p className="my-4 leading-7 text-ink-2">No parameters.</p>;
  return (
    <Table label="Parameters" containerClassName="my-6 rounded-xl border border-line bg-surface">
      <TableHeader>
        <TableRow>
          <TableHead className="px-3">Name</TableHead>
          <TableHead className="px-3">In</TableHead>
          <TableHead className="px-3">Type</TableHead>
          <TableHead className="px-3">Required</TableHead>
          <TableHead className="px-3">Default</TableHead>
          <TableHead className="px-3">Allowed values</TableHead>
          <TableHead className="px-3">Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {params.map((param) => (
          <TableRow key={`${param.in}:${param.name}`}>
            <TableCell className="whitespace-nowrap px-3 align-top font-mono text-[0.8125rem] font-semibold text-ink">{param.name}</TableCell>
            <TableCell className="px-3 align-top text-ink-2">{param.in}</TableCell>
            <TableCell className="px-3 align-top font-mono text-[0.8125rem] text-ink-2">{param.type}</TableCell>
            <TableCell className="px-3 align-top text-ink-2">{param.required ? "Required" : "Optional"}</TableCell>
            <TableCell className="px-3 align-top text-ink-2">
              {param.default === undefined ? NONE : <code className={cn(CODE_CLASS, "whitespace-nowrap [overflow-wrap:normal]")}>{String(param.default)}</code>}
            </TableCell>
            <TableCell className="min-w-32 px-3 align-top text-ink-2">{allowedValues(param)}</TableCell>
            <TableCell className="min-w-56 px-3 align-top leading-6 text-ink-2">
              <InlineText text={param.description} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
