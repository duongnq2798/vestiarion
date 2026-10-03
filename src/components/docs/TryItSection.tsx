import type { DocOperation } from "@/lib/api/openapi";
import TryIt from "./TryIt";

/** What a write's "Try it" section says instead of the panel (write API R8). */
export const TRY_IT_OFF = "Try it is off for operations that add records: run the sample with your own key.";

/**
 * A reference page's "Try it" section: the panel for a read, which sends the
 * request with the visitor's own key from the browser. A write gets none: a
 * request sent from the page would add real records to the visitor's
 * workspace. It says so, and the code samples below send the same request.
 */
export function TryItSection({ op }: { op: Pick<DocOperation, "id" | "method" | "path" | "params"> }) {
  if (op.method !== "get") return <p className="my-4 leading-7 text-ink-2">{TRY_IT_OFF}</p>;
  return <TryIt op={{ id: op.id, path: op.path, params: op.params }} />;
}
