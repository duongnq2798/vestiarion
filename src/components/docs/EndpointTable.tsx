import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";
import { OPERATIONS, type DocOperation } from "@/lib/api/openapi";
import { docsHref } from "@/lib/docs/paths";
import { LINK_CLASS, PathText } from "./InlineText";

/** The operations grouped by tag, tags in the order they first appear. */
export function operationsByTag(): Array<{ tag: DocOperation["tag"]; operations: DocOperation[] }> {
  const groups = new Map<DocOperation["tag"], DocOperation[]>();
  for (const op of OPERATIONS) groups.set(op.tag, [...(groups.get(op.tag) ?? []), op]);
  return [...groups].map(([tag, operations]) => ({ tag, operations }));
}

/**
 * Every v1 endpoint, one table per tag: its path, linked to its reference
 * page, and its summary. Rendered from `OPERATIONS`, so the overview lists
 * exactly the endpoints the reference pages and the OpenAPI document do.
 */
export function EndpointTable() {
  return (
    <div className="my-6 space-y-6">
      {operationsByTag().map(({ tag, operations }) => (
        <section key={tag} aria-label={tag}>
          <Eyebrow>{tag}</Eyebrow>
          <Table containerClassName="mt-2 rounded-xl border border-line bg-surface">
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Summary</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {operations.map((op) => (
                <TableRow key={op.id}>
                  <TableCell className="align-top">
                    <span className="flex items-start gap-2">
                      <Badge tone="agent" shape="tag" size="sm" className="mt-0.5 font-mono uppercase">
                        {op.method}
                      </Badge>
                      <Link
                        href={docsHref(`api/${op.id}`)}
                        className={cn(LINK_CLASS, "font-mono text-[0.8125rem] [overflow-wrap:break-word]")}
                      >
                        <PathText path={op.path} />
                      </Link>
                    </span>
                  </TableCell>
                  <TableCell className="min-w-36 align-top text-ink-2">{op.summary}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
    </div>
  );
}
