import { Badge } from "@/components/ui/Badge";
import { CopyButton } from "@/components/ui/CopyButton";
import type { DocOperation } from "@/lib/api/openapi";
import { PathText } from "./InlineText";

/**
 * The request line at the top of a reference page: the method and the path,
 * which wraps after a `/` rather than widening the page, labelled with the
 * operation's summary (the page's title).
 */
export function EndpointHeader({ op }: { op: Pick<DocOperation, "method" | "path" | "summary"> }) {
  return (
    <div role="group" aria-label={op.summary} className="flex items-start gap-3 rounded-xl border border-line bg-surface py-2 pl-3 pr-1 shadow-control">
      <Badge tone="agent" shape="tag" size="sm" className="mt-1.5 font-mono uppercase tracking-[0.08em]">
        {op.method.toUpperCase()}
      </Badge>
      <code className="min-w-0 flex-1 self-center font-mono text-sm leading-6 text-ink [overflow-wrap:break-word]">
        <PathText path={op.path} />
      </code>
      <CopyButton value={op.path} label="Copy path" />
    </div>
  );
}
