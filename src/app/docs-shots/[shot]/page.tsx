import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { PageHead } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { DOCS_SHOTS, type DocsShot } from "../shots";

/**
 * One guide screenshot's state, in a frame at a fixed width with the page's
 * title above it, for `scripts/docs-screenshots.mjs` to photograph
 * (workspace-delete-footer-screenshots design S1).
 *
 * It answers only where `DOCS_SCREENSHOTS=1` is set, which the script does for
 * the server it starts; everywhere else, production included, it is a 404.
 * The flag is read per request, never at build: the route is dynamic, so a
 * build is the same with the flag or without it.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Guide screenshot",
  robots: { index: false, follow: false },
};

type Props = { params: Promise<{ shot: string }> };

export default async function DocsShotPage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { shot: name } = await params;
  const shot: DocsShot | undefined = Object.hasOwn(DOCS_SHOTS, name) ? DOCS_SHOTS[name as keyof typeof DOCS_SHOTS] : undefined;
  if (!shot) notFound();

  return (
    <MotionProvider>
      <main id="main" className="min-h-dvh bg-ground p-10">
        <div
          data-docs-shot={name}
          data-verify-response={shot.verification ? JSON.stringify(shot.verification) : undefined}
          className="mx-auto w-[760px] bg-ground p-8"
        >
          <PageHead title={sectionTitle(shot.page)} sub={shot.sub} />
          {shot.render()}
        </div>
      </main>
    </MotionProvider>
  );
}
