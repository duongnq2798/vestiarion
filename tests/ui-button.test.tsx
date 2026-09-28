import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/Button";
import { SubmitButton, submittedBy } from "@/components/ui/SubmitButton";

const html = (node: ReactElement) => renderToStaticMarkup(node);

describe("Button", () => {
  it("is a plain button unless told to submit", () => {
    expect(html(<Button>Save</Button>)).toMatch(/^<button type="button"/);
  });

  it("keeps an explicit type", () => {
    expect(html(<Button type="submit">Save</Button>)).toMatch(/^<button type="submit"/);
  });

  it("while loading is disabled, busy, and shows a spinner in the icon’s place", () => {
    const markup = html(
      <Button loading icon={<svg data-icon="" />}>
        Save
      </Button>
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).not.toContain("data-icon");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("Save");
  });

  it("renders its child instead of a button with asChild", () => {
    const markup = html(
      <Button asChild variant="secondary">
        <a href="/x">Open</a>
      </Button>
    );
    expect(markup).toMatch(/^<a /);
    expect(markup).toContain('href="/x"');
    expect(markup).not.toContain("<button");
    expect(markup).toContain("border-line-strong");
  });

  it("lets a caller’s class beat the variant’s", () => {
    const markup = html(<Button className="px-8">Wide</Button>);
    expect(markup).toContain("px-8");
    expect(markup).not.toMatch(/\bpx-4\b/);
  });

  it("complains in development when an icon-only button has no name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    html(
      <Button size="icon">
        <svg />
      </Button>
    );
    expect(error).toHaveBeenCalledWith(expect.stringContaining("aria-label"));
    error.mockRestore();
  });

  it("stays quiet when an icon-only button is named", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    html(
      <Button size="icon" aria-label="Close">
        <svg />
      </Button>
    );
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("does not complain about an icon link named on the link itself", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    html(
      <Button asChild size="icon">
        <a href="/x" aria-label="Open">
          <svg />
        </a>
      </Button>
    );
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("SubmitButton", () => {
  it("submits, and is idle outside a pending form", () => {
    const markup = html(<SubmitButton pendingLabel="Saving…">Save</SubmitButton>);
    expect(markup).toMatch(/^<button type="submit"/);
    expect(markup).toContain("Save");
    expect(markup).not.toContain('aria-busy="true"');
  });

  it("can be marked busy by its owner", () => {
    const markup = html(
      <SubmitButton loading pendingLabel="Saving…">
        Save
      </SubmitButton>
    );
    expect(markup).toContain("Saving…");
    expect(markup).toContain('aria-busy="true"');
  });
});

describe("submittedBy — which submit button sent the form", () => {
  const data = new FormData();
  data.set("intent", "draft");

  it("is every button without a name", () => {
    expect(submittedBy(data, undefined, undefined)).toBe(true);
  });

  it("is the button whose name and value were sent, and no other", () => {
    expect(submittedBy(data, "intent", "draft")).toBe(true);
    expect(submittedBy(data, "intent", "submit")).toBe(false);
  });

  it("a named button without a value is not the sender when its sibling’s value was sent", () => {
    expect(submittedBy(data, "intent", undefined)).toBe(false);
  });

  it("a named button without a value is the sender when the empty value was sent", () => {
    const empty = new FormData();
    empty.set("intent", "");
    expect(submittedBy(empty, "intent", undefined)).toBe(true);
  });

  it("is no button while nothing is being submitted", () => {
    expect(submittedBy(null, "intent", "draft")).toBe(false);
  });
});
