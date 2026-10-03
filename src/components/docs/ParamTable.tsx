import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import type { DocParam } from "@/lib/api/openapi";
import { CODE_CLASS, InlineText } from "./InlineText";

const VALUE_CLASS = cn(CODE_CLASS, "whitespace-nowrap [overflow-wrap:normal]");

/** The values a parameter accepts beyond its type: its enum, or its range. Null when it names none. */
function allowedValues(param: DocParam): ReactNode {
  if (param.enum) {
    return param.enum.map((value) => (
      <code key={value} className={VALUE_CLASS}>
        {value}
      </code>
    ));
  }
  if (param.minimum !== undefined && param.maximum !== undefined) return <span>{`${param.minimum} to ${param.maximum}`}</span>;
  if (param.minimum !== undefined) return <span>{`at least ${param.minimum}`}</span>;
  if (param.maximum !== undefined) return <span>{`at most ${param.maximum}`}</span>;
  return null;
}

/** A labelled line under the description: "Default: 50", "Allowed: 1 to 200". */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
      <span className="text-ink-3">{`${label}:`}</span>
      {children}
    </p>
  );
}

/**
 * An operation's path and query parameters, one stacked item each, so a long
 * description wraps at any width instead of squeezing a column: the name,
 * its type, whether it is required and, for a path or header parameter, where it goes;
 * then what it does; then its default and allowed values, when it has them.
 */
export function ParamTable({ params }: { params: DocParam[] }) {
  if (params.length === 0) return <p className="my-4 leading-7 text-ink-2">No parameters.</p>;
  return (
    <ul aria-label="Parameters" className="my-6 divide-y divide-line rounded-xl border border-line bg-surface px-4">
      {params.map((param) => {
        const allowed = allowedValues(param);
        return (
          <li key={`${param.in}:${param.name}`} className="py-3.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <code className="font-mono text-[0.8125rem] font-semibold text-ink [overflow-wrap:anywhere]">{param.name}</code>
              <span className="rounded-md border border-line bg-raised/60 px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-2">{param.type}</span>
              <span className={cn("text-xs", param.required ? "font-semibold text-ink" : "text-ink-3")}>{param.required ? "required" : "optional"}</span>
              {param.in !== "query" && <span className="text-xs text-ink-3">{`in: ${param.in}`}</span>}
            </div>
            <p className="mt-1 text-sm leading-6 text-ink-2 [overflow-wrap:anywhere]">
              <InlineText text={param.description} />
            </p>
            {param.default !== undefined && (
              <Detail label="Default">
                <code className={VALUE_CLASS}>{String(param.default)}</code>
              </Detail>
            )}
            {allowed !== null && <Detail label="Allowed">{allowed}</Detail>}
          </li>
        );
      })}
    </ul>
  );
}
