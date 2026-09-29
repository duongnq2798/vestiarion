import { Disclosure } from "@/components/ui/Disclosure";
import { cn } from "@/components/ui/cn";
import type { SchemaNode } from "@/lib/docs/schema-tree";
import { CODE_CLASS, InlineText } from "./InlineText";

/** `string · nullable`, `object · optional`. */
export function typeLine(node: SchemaNode): string {
  return [node.type, node.nullable && "nullable", !node.required && "optional"].filter(Boolean).join(" · ");
}

function Field({ node, depth }: { node: SchemaNode; depth: number }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <code className="font-mono text-[0.8125rem] font-semibold text-ink [overflow-wrap:anywhere]">{node.name}</code>
        <span className="font-mono text-xs text-ink-3">{typeLine(node)}</span>
      </div>
      {node.description && (
        <p className="mt-1 text-sm leading-6 text-ink-2 [overflow-wrap:anywhere]">
          <InlineText text={node.description} />
        </p>
      )}
      {node.enum && (
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
          <span>One of</span>
          {node.enum.map((value) => (
            <code key={value} className={CODE_CLASS}>
              {value}
            </code>
          ))}
        </p>
      )}
      {node.children && (
        <Disclosure
          summary={
            <span>
              {node.children.length} {node.children.length === 1 ? "field" : "fields"} in <span className="font-mono text-ink">{node.name}</span>
            </span>
          }
          defaultOpen={depth === 0}
          className="mt-2.5 rounded-xl shadow-none"
          summaryClassName="rounded-xl px-3 py-2"
          contentClassName="px-3 pb-3"
        >
          <Fields nodes={node.children} depth={depth + 1} />
        </Disclosure>
      )}
    </li>
  );
}

function Fields({ nodes, depth }: { nodes: SchemaNode[]; depth: number }) {
  return (
    <ul className={cn("divide-y divide-line", depth > 0 && "border-t border-line pt-3")}>
      {nodes.map((node) => (
        <Field key={node.name} node={node} depth={depth} />
      ))}
    </ul>
  );
}

/**
 * A response's fields, nested: each object or array of objects opens into
 * its own fields. The top level starts open; deeper levels start closed, and
 * find-in-page still opens them.
 */
export function SchemaTree({ nodes, className }: { nodes: SchemaNode[]; className?: string }) {
  return (
    <div className={cn("my-6 rounded-xl border border-line bg-surface p-4", className)}>
      <Fields nodes={nodes} depth={0} />
    </div>
  );
}
