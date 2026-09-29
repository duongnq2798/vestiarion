import Link from "next/link";
import { Fragment } from "react";
import { cn } from "@/components/ui/cn";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { operationById } from "@/lib/api/openapi";
import { docsHref } from "@/lib/docs/paths";
import { MCP_TOOLS } from "@/lib/mcp/tools";
import { CODE_CLASS, LINK_CLASS } from "./InlineText";

/**
 * Every tool the MCP server lists: its name and arguments, what it answers
 * (the operation's summary), and the endpoint whose reference page it runs.
 * The table is for people: the full description the agent receives is on
 * that reference page and in `tools/list`. Rendered from `MCP_TOOLS`, which
 * is generated from `OPERATIONS`, so the table lists exactly the tools
 * `tools/list` answers with. The Markdown view writes the same table.
 */
export function McpToolTable() {
  return (
    <Table containerClassName="my-6 rounded-xl border border-line bg-surface">
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>What it answers</TableHead>
          <TableHead>Reference</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {MCP_TOOLS.map((tool) => {
          const args = Object.keys(tool.inputSchema.shape);
          const op = operationById(tool.operationId);
          return (
            <TableRow key={tool.name}>
              <TableCell className="align-top">
                {/* A tool name is one token: it never breaks at an underscore. */}
                <code className={cn(CODE_CLASS, "whitespace-nowrap")}>{tool.name}</code>
                {args.length > 0 && (
                  <div className="mt-2 text-xs leading-6 text-ink-3">
                    Arguments:{" "}
                    {args.map((arg, index) => (
                      <Fragment key={arg}>
                        {index > 0 && ", "}
                        <code className={cn(CODE_CLASS, "whitespace-nowrap")}>{arg}</code>
                      </Fragment>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="min-w-48 align-top text-sm leading-6">{tool.title}</TableCell>
              <TableCell className="align-top">
                <Link href={docsHref(`api/${tool.operationId}`)} className={LINK_CLASS}>
                  {op ? <code className={CODE_CLASS}>{`${op.method.toUpperCase()} ${op.path}`}</code> : tool.title}
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
