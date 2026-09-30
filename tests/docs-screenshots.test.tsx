import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Screenshot } from "@/components/docs/Screenshot";
import { CONTENT_DIR } from "@/lib/docs/content";
import { mdxToMarkdown, pageMarkdown } from "@/lib/docs/markdown";
import { pngSize, publicFile, SCREENSHOT_DIR, screenshotSize } from "@/lib/docs/screenshots";
import { DOCS_SHOT_NAMES, DOCS_SHOTS } from "@/app/docs-shots/shots";
import * as shotPage from "@/app/docs-shots/[shot]/page";
import { useMDXComponents } from "../mdx-components";

// The shots render the real cards, whose server actions import this guard.
vi.mock("server-only", () => ({}));

/**
 * The guides' step screenshots (workspace-delete-footer-screenshots design
 * S3, S4): every `<Screenshot>` shows a PNG that exists and says in words what
 * it shows; every PNG in public/docs/guides/ is shown somewhere; each is one
 * of the states /docs-shots renders, and that route answers only where the
 * screenshot script turned it on.
 */

const ROOT = process.cwd();
const SHOT_DIR = path.join(ROOT, "public", ...SCREENSHOT_DIR.split("/").filter(Boolean));
const ORIGIN = "https://x.test";

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]
  );
}

interface Use {
  file: string;
  src?: string;
  alt?: string;
  caption?: string;
}

/** Every `<Screenshot … />` in the docs' MDX, with its string attributes. */
const USES: Use[] = walk(CONTENT_DIR)
  .filter((file) => file.endsWith(".mdx"))
  .flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/<Screenshot\b([\s\S]*?)\/>/g)].map((match) => {
      const attributes = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
      return { file: path.relative(CONTENT_DIR, file).split(path.sep).join("/"), ...attributes };
    })
  );

const PNGS = readdirSync(SHOT_DIR).filter((name) => name.endsWith(".png"));

describe("the guides' screenshots", () => {
  it("are used", () => {
    expect(USES.length).toBeGreaterThanOrEqual(DOCS_SHOT_NAMES.length);
  });

  it.each(USES.map((use) => [`${use.file} ${use.src}`, use] as const))("%s is a PNG under public/, with alt text and a caption", (_name, use) => {
    expect(use.src).toMatch(/^\/docs\/guides\/[a-z0-9-]+\.png$/);
    const file = publicFile(use.src!);
    expect(file).not.toBeNull();
    expect(pngSize(readFileSync(file!))).not.toBeNull();
    expect(use.alt?.trim().length ?? 0).toBeGreaterThan(20);
    expect(use.caption?.trim()).toBeTruthy();
  });

  it("every PNG in public/docs/guides/ is shown in a guide", () => {
    const shown = new Set(USES.map((use) => use.src));
    expect(PNGS.filter((name) => !shown.has(`${SCREENSHOT_DIR}${name}`))).toEqual([]);
  });

  it("every PNG is one of the states /docs-shots renders, and each state has its PNG, shown in its own guide", () => {
    expect(PNGS.map((name) => name.replace(/\.png$/, "")).sort()).toEqual([...DOCS_SHOT_NAMES].sort());
    for (const name of DOCS_SHOT_NAMES) {
      const uses = USES.filter((use) => use.src === `${SCREENSHOT_DIR}${name}.png`);
      expect(uses.map((use) => use.file), name).toEqual([`guides/${DOCS_SHOTS[name].guide}.mdx`]);
    }
  });

  it("are small enough to load quickly, and sharp: twice the frame's width", () => {
    for (const name of PNGS) {
      const bytes = readFileSync(path.join(SHOT_DIR, name));
      expect(bytes.length, name).toBeLessThan(250 * 1024);
      expect(pngSize(bytes)?.width, name).toBe(1520);
    }
  });
});

describe("the screenshot script", () => {
  const script = readFileSync(path.join(ROOT, "scripts", "docs-screenshots.mjs"), "utf8");

  it("photographs exactly the states the route renders", () => {
    const listed = [...(/const SHOTS = \{([\s\S]*?)\n\};/.exec(script)?.[1] ?? "").matchAll(/^ {2}"([a-z0-9-]+)":/gm)].map((match) => match[1]);
    expect(listed).toEqual(DOCS_SHOT_NAMES);
  });

  it("is an npm script", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:screenshots"]).toBe("node scripts/docs-screenshots.mjs");
  });

  it("uses a throwaway Edge profile and stops only what it started", () => {
    expect(script).toContain("--user-data-dir=${profile}");
    expect(script).toContain("mkdtempSync(path.join(tmpdir()");
    expect(script).toMatch(/taskkill", \["\/PID", String\(child\.pid\), "\/T", "\/F"\]/);
    expect(script).not.toMatch(/taskkill[^\n]*\/IM/);
  });
});

describe("the frames' page lines", () => {
  it.each(DOCS_SHOT_NAMES.filter((name) => "sub" in DOCS_SHOTS[name]).map((name) => [name] as const))("%s quotes its page's line", (name) => {
    const shot = DOCS_SHOTS[name] as { page: string; sub: string };
    const source = readFileSync(path.join(ROOT, "src", "app", "o", "[slug]", shot.page, "page.tsx"), "utf8");
    expect(source).toContain(shot.sub);
  });
});

describe("Screenshot in Markdown", () => {
  it("is an image with its path made absolute, then its caption in italics", () => {
    const md = mdxToMarkdown(
      'Before.\n\n<Screenshot\n  src="/docs/guides/go-live-fund.png"\n  alt="Step 3 [funded]"\n  caption="The operating wallet holds 20.00 USDC."\n/>\n\nAfter.\n',
      ORIGIN
    );
    expect(md).toBe(`Before.\n\n![Step 3 \\[funded\\]](${ORIGIN}/docs/guides/go-live-fund.png)\n\n*The operating wallet holds 20.00 USDC.*\n\nAfter.\n`);
  });

  it("drops an empty caption, and refuses a screenshot without alt text", () => {
    expect(mdxToMarkdown('<Screenshot src="/docs/guides/a.png" alt="A" />\n', ORIGIN)).toBe(`![A](${ORIGIN}/docs/guides/a.png)\n`);
    expect(() => mdxToMarkdown('<Screenshot src="/docs/guides/a.png" alt=" " />\n', ORIGIN)).toThrow(/alt text/);
    expect(() => mdxToMarkdown('<Screenshot src="/docs/guides/a.png" />\n', ORIGIN)).toThrow(/alt text/);
  });

  it("is a block: MDX would read it inline inside a paragraph, so the converter refuses that", () => {
    expect(() => mdxToMarkdown('Text <Screenshot src="/docs/guides/a.png" alt="A" /> more.\n', ORIGIN)).toThrow(/block/);
  });

  it("appears in each guide's Markdown view, once per screenshot", () => {
    for (const guide of ["go-live", "first-payment"] as const) {
      const md = pageMarkdown(`guides/${guide}`, ORIGIN)!;
      for (const name of DOCS_SHOT_NAMES.filter((shot) => DOCS_SHOTS[shot].guide === guide)) {
        expect(md.split(`](${ORIGIN}/docs/guides/${name}.png)`).length - 1, name).toBe(1);
      }
    }
  });
});

describe("the Screenshot component", () => {
  it("is registered for MDX", () => {
    expect(useMDXComponents().Screenshot).toBe(Screenshot);
  });

  it("renders a lazy, framed, responsive image with the PNG's own size, and its caption", () => {
    const markup = renderToStaticMarkup(<Screenshot src="/docs/guides/go-live-fund.png" alt="Step 3" caption="Funded." />);
    const size = screenshotSize("/docs/guides/go-live-fund.png")!;
    expect(markup).toContain(`width="${size.width}"`);
    expect(markup).toContain(`height="${size.height}"`);
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('alt="Step 3"');
    const classes = /<img[^>]*class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
    expect(classes).toEqual(expect.arrayContaining(["w-full", "h-auto", "border", "border-line", "rounded-xl"]));
    expect(markup).toContain("<figcaption");
    expect(markup).toContain("Funded.");
    // Colours come from the tokens, never a literal.
    expect(readFileSync(path.join(ROOT, "src", "components", "docs", "Screenshot.tsx"), "utf8")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\[(?:#|rgb)/i);
  });

  it("leaves the size out, rather than fail the page, when the file cannot be read", () => {
    expect(screenshotSize("/docs/guides/nope.png")).toBeNull();
    expect(renderToStaticMarkup(<Screenshot src="/docs/guides/nope.png" alt="Nope" />)).not.toContain("width=");
  });

  it("reads a PNG's size from its header, and only from files under public/", () => {
    expect(pngSize(Buffer.from("not a png at all, not at all"))).toBeNull();
    expect(publicFile("/../package.json")).toBeNull();
    expect(publicFile("//evil.example/x.png")).toBeNull();
    expect(publicFile("docs/guides/a.png")).toBeNull();
    expect(publicFile("/docs/guides/a.png")).toBe(path.join(ROOT, "public", "docs", "guides", "a.png"));
  });
});

describe("/docs-shots/<name>", () => {
  const NOT_FOUND = expect.objectContaining({ digest: expect.stringContaining("404") });
  const params = (shot: string) => ({ params: Promise.resolve({ shot }) });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is rendered per request, never prerendered, and kept out of search", () => {
    expect(shotPage.dynamic).toBe("force-dynamic");
    expect(shotPage.metadata.robots).toEqual({ index: false, follow: false });
  });

  it.each([[undefined], [""], ["0"], ["true"]])("is not found when DOCS_SCREENSHOTS is %j, whatever the shot", async (flag) => {
    vi.stubEnv("DOCS_SCREENSHOTS", flag);
    for (const name of [...DOCS_SHOT_NAMES, "nope"]) await expect(shotPage.default(params(name))).rejects.toEqual(NOT_FOUND);
  });

  it("with DOCS_SCREENSHOTS=1, renders each shot in its frame, and nothing else", async () => {
    vi.stubEnv("DOCS_SCREENSHOTS", "1");
    for (const name of DOCS_SHOT_NAMES) await expect(shotPage.default(params(name))).resolves.toBeTruthy();
    await expect(shotPage.default(params("nope"))).rejects.toEqual(NOT_FOUND);
    await expect(shotPage.default(params("toString"))).rejects.toEqual(NOT_FOUND);
  });
});
