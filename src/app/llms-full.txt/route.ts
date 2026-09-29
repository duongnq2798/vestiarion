import { llmsFull } from "@/lib/docs/markdown";
import { publicOrigin } from "@/lib/public-origin";

/** `/llms-full.txt`: every docs page's Markdown in one document, in nav order. Public and static. */
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsFull(publicOrigin()), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
