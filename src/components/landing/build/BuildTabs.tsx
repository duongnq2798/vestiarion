"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { SNIPPETS } from "./snippets";
import { Terminal } from "./Terminal";

/** The ways in, one tab each, each typed into its own terminal. */
export function BuildTabs() {
  return (
    <Tabs defaultValue={SNIPPETS[0].id} className="min-w-0 gap-3">
      <TabsList aria-label="Ways to build on Vestiarion">
        {SNIPPETS.map((snippet) => (
          <TabsTrigger key={snippet.id} value={snippet.id}>
            {snippet.tab}
          </TabsTrigger>
        ))}
      </TabsList>
      {SNIPPETS.map((snippet) => (
        <TabsContent key={snippet.id} value={snippet.id} className="min-w-0">
          <Terminal snippet={snippet} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
