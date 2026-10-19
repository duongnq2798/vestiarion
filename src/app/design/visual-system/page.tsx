import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { Heading } from "@/components/ui/Heading";
import { Section } from "@/components/ui/Section";

export const metadata: Metadata = {
  title: "Public visual system specimen",
  robots: { index: false, follow: false },
};

/** Development specimen, not a payment example or a public landing page. */
export default function VisualSystemPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <main id="main">
      <Section tone="agent" aria-labelledby="positioning">
        <Eyebrow inverse>Vestiarion · visual system specimen</Eyebrow>
        <Heading as="h1" size="positioning" id="positioning" className="mt-6 max-w-3xl">
          Your AI agent for bills and payments
        </Heading>
        <Heading as="p" size="display" className="mt-8 max-w-[12ch]">
          Every bill. A clear way through.
        </Heading>
        <p className="mt-8 max-w-xl text-lede text-on-agent-muted">
          Typography and controls for the public pages. This development specimen contains no live payment evidence.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-6">
          <Button asChild variant="inverse" size="lg"><a href="#principles">Explore the system</a></Button>
          <a href="#controls" className="text-ui font-semibold underline underline-offset-4">View controls</a>
        </div>
      </Section>

      <Section id="principles" aria-labelledby="principles-title">
        <Eyebrow>Clear hierarchy · familiar palette</Eyebrow>
        <Heading id="principles-title" className="mt-4 max-w-4xl">The AI suggests. Your rules in code decide.</Heading>
        <p className="mt-6 max-w-2xl text-lede text-ink-2">
          Large type carries the idea. Compact, readable details carry the evidence. Agent-blue and warm cream remain the shared foundation.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          {[
            ["01 / Type", "One clear hierarchy", "Positioning, display and section headings scale with the viewport. Body and interface sizes remain familiar."],
            ["02 / Space", "Room for each step", "Fluid page gutters and section spacing follow the existing four-pixel rhythm."],
            ["03 / Evidence", "A quiet surface", "Flat cards frame product information; elevation remains available for interactive and floating surfaces."],
          ].map(([label, title, description]) => (
            <Card key={label} elevation="flat">
              <CardContent>
                <Eyebrow>{label}</Eyebrow>
                <h3 className="mt-5 text-xl font-semibold tracking-tight text-ink">{title}</h3>
                <p className="mt-3 text-body text-ink-2">{description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </Section>

      <Section tone="ink" aria-labelledby="contrast-title">
        <Eyebrow inverse>Contrast and keyboard focus</Eyebrow>
        <Heading id="contrast-title" className="mt-4 max-w-3xl">Readable at every step.</Heading>
        <p className="mt-6 max-w-2xl text-lede text-on-agent-muted">
          Solid secondary text stays readable on dark surfaces. Every blue or ink section gives keyboard focus a white outline.
        </p>
        <Button asChild variant="inverse" className="mt-8"><a href="#controls">Continue to controls</a></Button>
      </Section>

      <Section tone="surface" id="controls" aria-labelledby="controls-title">
        <Eyebrow>Shared primitives</Eyebrow>
        <Heading id="controls-title" className="mt-4">Familiar controls.</Heading>
        <p className="mt-6 max-w-2xl text-lede text-ink-2">Existing control sizes, states and behaviour carry through to the new public system.</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <Button asChild><a href="#positioning">Back to typography</a></Button>
          <Button asChild variant="secondary"><a href="#principles">Review the principles</a></Button>
        </div>
      </Section>
    </main>
  );
}
