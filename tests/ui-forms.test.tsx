import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FileInput } from "@/components/ui/FileInput";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input, Textarea } from "@/components/ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Field", () => {
  it("labels its control and points it at the description", () => {
    const markup = html(
      <Field id="email" label="Email" description="Where the link goes">
        <Input name="email" />
      </Field>
    );
    expect(markup).toContain('<label for="email"');
    expect(markup).toContain('id="email"');
    expect(markup).toContain('aria-describedby="email-description"');
    expect(markup).toContain('id="email-description"');
    // Not a bare "aria-invalid" substring check: controlBase always carries the
    // static `aria-invalid:border-refused` Tailwind variant class, so that
    // substring is present whether or not the attribute itself is rendered.
    expect(markup).not.toContain('aria-invalid="');
  });

  it("marks its control invalid and names the error", () => {
    const markup = html(
      <Field id="amount" label="Amount" description="USDC" error="Must be positive">
        <Input name="amount" />
      </Field>
    );
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="amount-description amount-error"');
    expect(markup).toContain('id="amount-error"');
  });

  it("gives a select trigger the same wiring", () => {
    const markup = html(
      <Field id="role" label="Role">
        <Select name="role" defaultValue="viewer">
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="viewer">Viewer</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    );
    expect(markup).toMatch(/<button[^>]*id="role"/);
  });

  it("leaves a control outside a Field as it was given", () => {
    const markup = html(<Input id="own" aria-describedby="elsewhere" />);
    expect(markup).toContain('id="own"');
    expect(markup).toContain('aria-describedby="elsewhere"');
  });

  it("uses 16px text on phones, so iOS does not zoom into the field", () => {
    expect(html(<Input />)).toContain("text-base");
    expect(html(<Textarea />)).toContain("sm:text-sm");
  });
});

describe("Checkbox", () => {
  it("is a labelled checkbox", () => {
    const markup = html(<Checkbox id="received" name="goodsReceived" label="Goods received" />);
    expect(markup).toContain('role="checkbox"');
    expect(markup).toContain('<label for="received"');
  });
});

describe("FileInput", () => {
  it("keeps a real, focusable file input under its label", () => {
    const markup = html(<FileInput id="csv" name="csv" accept=".csv" label="Choose a CSV file" onFile={() => {}} />);
    expect(markup).toContain('<label for="csv"');
    expect(markup).toMatch(/<input[^>]*type="file"/);
    expect(markup).toContain('accept=".csv"');
    expect(markup).toContain("sr-only");
  });
});

describe("FormMessage", () => {
  it("is a live region that is there even while empty", () => {
    const markup = html(<FormMessage />);
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("says an error with an icon, not by colour alone", () => {
    const markup = html(<FormMessage tone="error">Amount must be positive</FormMessage>);
    expect(markup).toContain("text-refused");
    expect(markup).toContain("<svg");
    expect(markup).toContain("Amount must be positive");
  });
});
