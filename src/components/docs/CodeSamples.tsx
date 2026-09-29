import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import type { SampleLang } from "@/lib/docs/samples";
import { CodeBlock } from "./CodeBlock";

const LANGUAGES: Array<{ id: SampleLang; label: string; shiki: string }> = [
  { id: "curl", label: "cURL", shiki: "bash" },
  { id: "javascript", label: "JavaScript", shiki: "javascript" },
  { id: "python", label: "Python", shiki: "python" },
];

/**
 * The request in cURL, JavaScript and Python, one tab each. Every sample is
 * highlighted on the server; the tabs only choose which one shows.
 */
export function CodeSamples({ samples }: { samples: Record<SampleLang, string> }) {
  return (
    <Tabs defaultValue="curl" className="my-6 gap-3">
      <TabsList aria-label="Language">
        {LANGUAGES.map((language) => (
          <TabsTrigger key={language.id} value={language.id}>
            {language.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {LANGUAGES.map((language) => (
        <TabsContent key={language.id} value={language.id}>
          <CodeBlock code={samples[language.id]} lang={language.shiki} label={language.label} className="my-0" />
        </TabsContent>
      ))}
    </Tabs>
  );
}
