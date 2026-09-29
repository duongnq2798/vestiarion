import { llmsIndex } from "@/lib/docs/markdown";
import { publicOrigin } from "@/lib/public-origin";

/** `/llms.txt`: an index of the docs for language models, each page linked by its Markdown view. Public and static. */
export const dynamic = "force-static";

export function GET() {
  return new Response(llmsIndex(publicOrigin()), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
  });
}
