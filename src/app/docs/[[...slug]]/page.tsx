import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headingComponents } from "@/components/docs/DocsHeading";
import { DocsPage } from "@/components/docs/DocsShell";
import { hasSource, loadPage, readSource } from "@/lib/docs/content";
import { slugifyHeadings } from "@/lib/docs/headings";
import { docsHref, findPage, flatPages } from "@/lib/docs/nav";

type Props = { params: Promise<{ slug?: string[] }> };

/** Every page written in MDX. The generated `api/<id>` reference pages have their own route. */
export function generateStaticParams() {
  return flatPages()
    .filter((page) => !page.slug.startsWith("api/") && hasSource(page.slug))
    .map((page) => ({ slug: page.slug ? page.slug.split("/") : [] }));
}

export const dynamicParams = false;

function slugOf(segments: string[] | undefined): string {
  return (segments ?? []).join("/");
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = findPage(slugOf((await params).slug));
  if (!found) return {};
  return {
    title: { absolute: `${found.page.title} · Vestiarion docs` },
    description: found.page.description,
    alternates: { canonical: docsHref(found.page.slug) },
  };
}

export default async function DocsSlugPage({ params }: Props) {
  const slug = slugOf((await params).slug);
  const found = findPage(slug);
  const loaded = found ? await loadPage(slug) : null;
  if (!found || !loaded) notFound();

  // The ids come from the source, once: the headings, the table of contents and every link agree on them.
  const headings = slugifyHeadings(readSource(slug));
  const { Content } = loaded;

  return (
    <DocsPage slug={slug} section={found.section} title={found.page.title} description={found.page.description} headings={headings}>
      <Content components={headingComponents(headings)} />
    </DocsPage>
  );
}
