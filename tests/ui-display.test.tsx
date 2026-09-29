import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { Disclosure } from "@/components/ui/Disclosure";
import { EmptyState } from "@/components/ui/EmptyState";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/Table";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Badge", () => {
  it("colours by tone and still says it in words", () => {
    const markup = html(<Badge tone="refused">Refused by guardrail</Badge>);
    expect(markup).toContain("text-refused");
    expect(markup).toContain("Refused by guardrail");
  });

  it("hatches what is simulated", () => {
    expect(html(<Badge tone="simulated">Simulated</Badge>)).toContain("hatch");
  });

  it("draws a dot in its tone when asked", () => {
    expect(html(<Badge tone="proof" dot>Live</Badge>)).toContain("bg-proof");
  });
});

describe("Callout", () => {
  it("draws its tone’s icon and takes the role it is given", () => {
    const markup = html(
      <Callout tone="refused" role="alert" title="Blocked by code">
        The guardrail refused it.
      </Callout>
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("<svg");
    expect(markup).toContain("Blocked by code");
  });

  it("has no role unless given one", () => {
    expect(html(<Callout>Standing information</Callout>)).not.toContain("role=");
  });
});

describe("ProgressBar", () => {
  it("reports a determinate value", () => {
    const markup = html(<ProgressBar value={42} label="Import" />);
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
  });

  it("leaves the value out while indeterminate", () => {
    const markup = html(<ProgressBar label="Running the cycle" />);
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).toContain("animate-sweep");
  });

  it("clamps a value outside 0–100", () => {
    expect(html(<ProgressBar value={140} label="Import" />)).toContain('aria-valuenow="100"');
  });

  it("treats a value that is not a number as indeterminate", () => {
    const markup = html(<ProgressBar value={Number.NaN} label="Import" />);
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).toContain("animate-sweep");
  });
});

describe("EmptyState", () => {
  it("titles itself at the level it is given", () => {
    expect(html(<EmptyState title="No invoices" titleAs="h2" />)).toContain("<h2");
    expect(html(<EmptyState title="No invoices" />)).toContain("<h3");
  });

  it("can be a page's main heading", () => {
    expect(html(<EmptyState title="This invitation has expired" titleAs="h1" />)).toContain("<h1");
  });
});

describe("Avatar", () => {
  it("shows an initial and hides from screen readers", () => {
    const markup = html(<Avatar name="  acme treasury" />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain(">a<");
  });

  it("falls back when the name is blank", () => {
    expect(html(<Avatar name="   " />)).toContain(">?<");
  });

  it("keeps an emoji whole", () => {
    expect(html(<Avatar name="🦊 Fox" />)).toContain("🦊");
  });
});

describe("Disclosure", () => {
  it("is a details element the stylesheet can animate", () => {
    const markup = html(<Disclosure summary="Score inputs">Four clean payments</Disclosure>);
    expect(markup).toMatch(/^<details class="disclosure/);
    expect(markup).toContain("<summary");
    expect(markup).toContain("Four clean payments");
  });

  it("opens when asked", () => {
    expect(
      html(
        <Disclosure summary="Key" defaultOpen>
          PEM
        </Disclosure>
      )
    ).toMatch(/<details[^>]* open=""/);
  });

  it("draws no frame or chevron when bare", () => {
    const markup = html(
      <Disclosure variant="bare" summary="#0042">
        detail
      </Disclosure>
    );
    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("rounded-2xl");
  });
});

describe("Table", () => {
  it("scrolls sideways instead of widening the page", () => {
    const markup = html(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Email</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>ada@example.com</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(markup).toMatch(/^<div class="[^"]*overflow-x-auto/);
    expect(markup).toContain('scope="col"');
  });

  it("lets its frame scroll both ways when asked, for a sticky header", () => {
    const markup = html(
      <Table containerClassName="max-h-72 overflow-auto">
        <TableBody>
          <TableRow>
            <TableCell>row</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(markup).toMatch(/^<div class="[^"]*max-h-72/);
    expect(markup).toContain("overflow-auto");
    expect(markup).not.toContain("overflow-x-auto");
  });
});

describe("Card", () => {
  it("renders a link with the card’s look through asChild", () => {
    const markup = html(
      <Card asChild interactive>
        <a href="#x">Open</a>
      </Card>
    );
    expect(markup).toMatch(/^<a /);
    expect(markup).toContain("hover:shadow-raised");
  });
});
