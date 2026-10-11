import { ZoomableImage } from "@/components/ui/ZoomableImage";
import { screenshotSize } from "@/lib/docs/screenshots";

/**
 * A step's screenshot in a guide: the image, framed and scaled to the column,
 * with its caption below. Its width and height come from the PNG, so the page
 * does not move when it loads. Choosing it opens it larger in a dialog
 * (`ZoomableImage`, docs clarity C3). In the `.md` view it is a Markdown image
 * and an italic caption (`MDX_TO_MARKDOWN` in src/lib/docs/markdown.ts).
 */
export function Screenshot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  const size = screenshotSize(src);
  return (
    <figure className="my-7">
      <ZoomableImage
        src={src}
        alt={alt}
        width={size?.width}
        height={size?.height}
        className="block h-auto w-full max-w-full rounded-xl border border-line bg-surface shadow-surface"
      />
      {caption && <figcaption className="mt-2.5 text-center text-[0.875rem] leading-relaxed text-ink-3 [overflow-wrap:anywhere]">{caption}</figcaption>}
    </figure>
  );
}
