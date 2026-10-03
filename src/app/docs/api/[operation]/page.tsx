import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/docs/CodeBlock";
import { CodeSamples } from "@/components/docs/CodeSamples";
import { DocsHeading, headingComponents } from "@/components/docs/DocsHeading";
import { DocsPage } from "@/components/docs/DocsShell";
import { EndpointHeader } from "@/components/docs/EndpointHeader";
import { ErrorTable } from "@/components/docs/ErrorTable";
import { CODE_CLASS, LINK_CLASS, Paragraphs } from "@/components/docs/InlineText";
import { ParamTable } from "@/components/docs/ParamTable";
import { SchemaTree } from "@/components/docs/SchemaTree";
import { TryItSection } from "@/components/docs/TryItSection";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { jsonSchema, OPERATIONS, operationById } from "@/lib/api/openapi";
import { loadNotes } from "@/lib/docs/content";
import { docsHref, findPage } from "@/lib/docs/nav";
import { docsSocialMetadata } from "@/lib/docs/social";
import { publicOrigin } from "@/lib/public-origin";
import { notesHeadings, REFERENCE_SECTIONS, referenceHeadings, sectionId, type ReferenceSection } from "@/lib/docs/reference";
import { sampleRequest } from "@/lib/docs/samples";
import { schemaTree } from "@/lib/docs/schema-tree";

type Props = { params: Promise<{ operation: string }> };

/** One page per operation, generated from its entry in `OPERATIONS`. */
export function generateStaticParams() {
  return OPERATIONS.map((op) => ({ operation: op.id }));
}

/**
 * An address outside the static params still reaches this page, which answers
 * it with `notFound()` before reading any file, so the docs' own not-found
 * page renders, inside the docs shell with its search, instead of the site's.
 */
export const dynamicParams = true;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = findPage(`api/${(await params).operation}`);
  if (!found) return {};
  return {
    title: { absolute: `${found.page.title} · Vestiarion docs` },
    description: found.page.description,
    alternates: { canonical: docsHref(found.page.slug) },
    ...docsSocialMetadata(found.page),
  };
}

function Section({ section }: { section: ReferenceSection }) {
  return (
    <DocsHeading depth={2} id={sectionId(section)}>
      {REFERENCE_SECTIONS[section]}
    </DocsHeading>
  );
}

/**
 * The reference for one `/api/v1` operation: the request line and what it
 * does, its parameters, a write's request body (an example and the schema's
 * fields), request samples, the response (an example and the schema's
 * fields), its errors, and notes where `content/docs/api/<id>.mdx` adds
 * something beyond the schema.
 */
export default async function ApiReferencePage({ params }: Props) {
  const op = operationById((await params).operation);
  const slug = `api/${op?.id}`;
  const found = findPage(slug);
  if (!op || !found) notFound();

  const notes = await loadNotes(op.id);
  // The fixed sections, then the notes' own headings: the table of contents, the anchors and the link checker agree on them.
  const headings = referenceHeadings(notes?.source ?? null, { body: op.requestBody !== undefined });

  return (
    <DocsPage slug={slug} section={found.section} title={op.summary} headings={headings}>
      <EndpointHeader op={op} />
      <Paragraphs text={op.description} />
      <p className="my-4 leading-7 text-ink-2">
        Send a{" "}
        <Link href="/docs/get-started/authentication" className={LINK_CLASS}>
          workspace API key
        </Link>{" "}
        {op.scope === "write" ? "with read and write access " : ""}as <code className={CODE_CLASS}>Authorization: Bearer …</code>.
        {op.scope === "write" && (
          <>
            {" "}A read-only key gets <code className={CODE_CLASS}>403</code>.
          </>
        )}
      </p>

      <Section section="parameters" />
      <ParamTable params={op.params} />

      {op.requestBody && (
        <>
          <Section section="body" />
          <Eyebrow className="block">Example</Eyebrow>
          <CodeBlock code={JSON.stringify(op.requestExample ?? {}, null, 2)} lang="json" label="application/json" className="mt-2" />
          <Eyebrow className="mt-8 block">Fields</Eyebrow>
          <SchemaTree nodes={schemaTree(jsonSchema(op.requestBody))} className="mt-2" />
        </>
      )}

      <Section section="tryIt" />
      <TryItSection op={op} />

      <Section section="samples" />
      <CodeSamples samples={sampleRequest(op, publicOrigin())} />

      <Section section="response" />
      <Eyebrow className="block">Example</Eyebrow>
      <CodeBlock code={JSON.stringify(op.example, null, 2)} lang="json" label={`${op.status} · application/json`} className="mt-2" />
      <Eyebrow className="mt-8 block">Fields</Eyebrow>
      <SchemaTree nodes={schemaTree(jsonSchema(op.response))} className="mt-2" />

      <Section section="errors" />
      <ErrorTable codes={op.errors} />

      {notes && (
        <>
          <Section section="notes" />
          <notes.Content components={headingComponents(notesHeadings(headings))} />
        </>
      )}
    </DocsPage>
  );
}
