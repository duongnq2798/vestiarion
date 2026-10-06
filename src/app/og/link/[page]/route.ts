import { linkPreviewImage } from "@/app/_og/SocialPreview";
import { LINK_PREVIEWS, type LinkPage } from "@/lib/link-previews";

/**
 * The preview card of each kind of link page (docs/superpowers/specs/2026-10-06-mainnet-polish-design.md E1), at
 * `linkImagePath(page)`: `/pay`, `/payee` and `/receipt` point their metadata here. Like the docs pages' images it is a
 * route under `og/`, so every card is rendered at build time and the proxy never runs for a crawler's fetch (final
 * review I2). It reads nothing of any link; any other page is a 404.
 */
export function generateStaticParams() {
  return Object.keys(LINK_PREVIEWS).map((page) => ({ page }));
}

export const dynamicParams = false;

export async function GET(_request: Request, { params }: { params: Promise<{ page: string }> }) {
  const { page } = await params;
  return page in LINK_PREVIEWS ? linkPreviewImage(page as LinkPage) : new Response(null, { status: 404 });
}
