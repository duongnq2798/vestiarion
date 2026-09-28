import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CopyButton } from "@/components/ui/CopyButton";
import { Reveal } from "@/components/ui/Reveal";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { TooltipProvider } from "@/components/ui/Tooltip";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Reveal", () => {
  it("hides nothing in the server’s HTML", () => {
    const markup = html(
      <Reveal delay={120}>
        <p>Measured</p>
      </Reveal>
    );
    expect(markup).toContain("<p>Measured</p>");
    expect(markup).not.toContain("data-reveal");
    expect(markup).not.toContain("opacity");
  });
});

describe("Tabs", () => {
  const tabs = (
    <Tabs defaultValue="manual">
      <TabsList aria-label="Invoice intake">
        <TabsTrigger value="manual">Enter one invoice</TabsTrigger>
        <TabsTrigger value="csv">Import CSV</TabsTrigger>
      </TabsList>
      <TabsContent value="manual">Manual form</TabsContent>
      <TabsContent value="csv">CSV form</TabsContent>
    </Tabs>
  );

  it("renders the default tab’s panel on the server", () => {
    const markup = html(tabs);
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("Manual form");
    expect(markup).not.toContain("CSV form");
  });

  it("marks exactly one tab as selected", () => {
    expect(html(tabs).match(/data-tab-indicator/g)).toHaveLength(1);
  });
});

describe("CopyButton", () => {
  it("names itself for screen readers when it is only an icon", () => {
    const markup = html(
      <TooltipProvider>
        <CopyButton value="0xabc" label="Copy transaction hash" />
      </TooltipProvider>
    );
    expect(markup).toContain('aria-label="Copy transaction hash"');
  });

  it("shows its text when it has some", () => {
    expect(html(<CopyButton value="https://example.com/invite">Copy link</CopyButton>)).toContain("Copy link");
  });
});
