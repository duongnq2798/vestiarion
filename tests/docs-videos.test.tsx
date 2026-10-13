import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Video, type VideoProps } from "@/components/docs/Video";
import { CONTENT_DIR, readSource } from "@/lib/docs/content";
import { mdxToMarkdown, pageMarkdown } from "@/lib/docs/markdown";
import { publicFile } from "@/lib/docs/screenshots";
import { isoDuration, VIDEO_ATTRIBUTES, VIDEO_DIR, videoProblem } from "@/lib/docs/videos";
import { useMDXComponents } from "../mdx-components";

/**
 * The guides' walkthrough videos: every `<Video>` plays an MP4 under
 * public/docs/videos/ that exists, starts at once and is as long as the page
 * says, with its poster, a caption that says where it was recorded and its
 * transcript; every file there is shown by a guide. The player is the
 * browser's own, loads nothing until played and never plays on its own.
 */

const ROOT = process.cwd();
const VIDEO_FILES_DIR = path.join(ROOT, "public", ...VIDEO_DIR.split("/").filter(Boolean));
const ORIGIN = "https://x.test";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** A type, not an interface, so it reads as the attribute record `videoProblem` takes. */
type Use = {
  file: string;
  src?: string;
  poster?: string;
  title?: string;
  caption?: string;
  duration?: string;
  transcript: string;
};

const MDX = walk(CONTENT_DIR).filter((file) => file.endsWith(".mdx"));
const relativeToContent = (file: string) => path.relative(CONTENT_DIR, file).split(path.sep).join("/");

/** Every `<Video …>transcript</Video>` in the docs' MDX, with its string attributes. */
const USES: Use[] = MDX.flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/<Video\b([^>]*)>([\s\S]*?)<\/Video>/g)].map((match) => {
    const attributes = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
    return { file: relativeToContent(file), ...attributes, transcript: match[2].trim() };
  })
);

const FILES = readdirSync(VIDEO_FILES_DIR);

/** An MP4's top-level boxes in order, and its length in seconds from the movie header (`moov` > `mvhd`). */
function mp4(bytes: Buffer): { boxes: string[]; seconds: number | null } {
  const boxes: string[] = [];
  let seconds: number | null = null;
  for (let at = 0; at + 8 <= bytes.length; ) {
    let size = bytes.readUInt32BE(at);
    let header = 8;
    if (size === 1) {
      size = Number(bytes.readBigUInt64BE(at + 8));
      header = 16;
    } else if (size === 0) {
      size = bytes.length - at;
    }
    if (size < header) break;
    const type = bytes.toString("latin1", at + 4, at + 8);
    boxes.push(type);
    if (type === "moov") {
      for (let child = at + header; child + 8 <= at + size; ) {
        const childSize = bytes.readUInt32BE(child);
        if (childSize < 8) break;
        if (bytes.toString("latin1", child + 4, child + 8) === "mvhd") {
          const body = child + 8;
          const version = bytes[body];
          const timescale = bytes.readUInt32BE(body + (version === 1 ? 20 : 12));
          const duration = version === 1 ? Number(bytes.readBigUInt64BE(body + 24)) : bytes.readUInt32BE(body + 16);
          seconds = duration / timescale;
        }
        child += childSize;
      }
    }
    at += size;
  }
  return { boxes, seconds };
}

const minutesAndSeconds = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

describe("the guides' videos", () => {
  it("are in the Xero and HubSpot guides, one each, and nowhere else", () => {
    expect(USES.map((use) => [use.file, use.src])).toEqual([
      ["guides/hubspot.mdx", "/docs/videos/hubspot-flow.mp4"],
      ["guides/xero.mdx", "/docs/videos/xero-flow.mp4"],
    ]);
    // Every `<Video` is one the list above read: none is self-closing, without its transcript.
    const opened = MDX.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/<Video\b/g)]);
    expect(opened).toHaveLength(USES.length);
  });

  it.each(USES.map((use) => [use.file, use] as const))("in %s: an MP4 and its poster under public/docs/videos/, a title, a caption and a transcript", (_file, use) => {
    expect(videoProblem(use, use.transcript !== "")).toBeNull();
    expect(use.src).toMatch(/^\/docs\/videos\/[a-z0-9-]+\.mp4$/);
    expect(use.poster).toBe(use.src!.replace(/\.mp4$/, "-poster.jpg"));
    for (const src of [use.src!, use.poster!]) expect(statSync(publicFile(src)!).isFile(), src).toBe(true);
    // Plain and true: where it was recorded, in words, on the page.
    expect(use.caption).toContain("The live product on Arc testnet, with demo data");
    expect(use.caption).toMatch(/Recorded [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);
    expect(use.caption).not.toMatch(/certified|official|endorsed|partner/i);
    expect(use.title!.length).toBeGreaterThan(15);
    expect(use.transcript.split(/\n[ \t]*\n/).length).toBeGreaterThan(10);
  });

  it.each(USES.map((use) => [use.src!, use] as const))("%s starts playing before it has all loaded, and is as long as its page says", (_src, use) => {
    const bytes = readFileSync(publicFile(use.src!)!);
    const { boxes, seconds } = mp4(bytes);
    expect(boxes[0]).toBe("ftyp");
    // Fast start: the index comes before the media, so playback begins from the first bytes.
    expect(boxes.indexOf("moov")).toBeGreaterThan(-1);
    expect(boxes.indexOf("moov")).toBeLessThan(boxes.indexOf("mdat"));
    expect(seconds).not.toBeNull();
    expect(minutesAndSeconds(seconds!)).toBe(use.duration);
  });

  it("every file in public/docs/videos/ is a video or poster a guide shows", () => {
    expect(FILES.filter((name) => !/^[a-z0-9-]+\.(mp4|jpg)$/.test(name))).toEqual([]);
    const shown = new Set(USES.flatMap((use) => [use.src, use.poster]));
    expect(FILES.filter((name) => !shown.has(`${VIDEO_DIR}${name}`))).toEqual([]);
  });

  it("are left out of the server functions' file traces: they are public files, read by no server code", () => {
    expect(readFileSync(path.join(ROOT, "next.config.ts"), "utf8")).toMatch(/outputFileTracingExcludes: \{\s*"\/\*": \["public\/docs\/videos\/\*\*"\]/);
  });

  it("are small enough to load quickly, and the posters are JPEGs", () => {
    for (const name of FILES) {
      const bytes = readFileSync(path.join(VIDEO_FILES_DIR, name));
      if (name.endsWith(".mp4")) {
        expect(bytes.length, name).toBeLessThan(5 * 1024 * 1024);
      } else {
        expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), name).toBe(true);
        expect(bytes.length, name).toBeLessThan(150 * 1024);
      }
    }
  });
});

describe("each guide's Watch it section", () => {
  it.each(["guides/xero", "guides/hubspot"] as const)("%s has it after the introduction, before Before you start and step 1, holding the video", (slug) => {
    const guide = readSource(slug);
    const headings = [...guide.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings.slice(0, 3)).toEqual(["Watch it", "Before you start", headings.find((heading) => /^1\. /.test(heading))]);
    const section = guide.slice(guide.indexOf("## Watch it"), guide.indexOf("## Before you start"));
    expect(section).toContain("<Video");
    expect(section).toContain("</Video>");
    // The introduction comes first.
    expect(guide.indexOf("## Watch it")).toBeGreaterThan(200);
  });

  it("is linked from the docs Overview", () => {
    const overview = readSource("");
    expect(overview).toContain('href="/docs/guides/xero#watch-it"');
    expect(overview).toContain('href="/docs/guides/hubspot#watch-it"');
  });
});

const PROPS: VideoProps = {
  src: "/docs/videos/xero-flow.mp4",
  poster: "/docs/videos/xero-flow-poster.jpg",
  title: "Bills from Xero",
  caption: "The live product on Arc testnet, with demo data.",
  duration: "1:52",
};

const render = (props: Partial<VideoProps>, transcript: boolean = true) =>
  renderToStaticMarkup(
    <Video {...(props as VideoProps)}>
      {transcript ? (
        <>
          <p>First line.</p>
          <p>Second line.</p>
        </>
      ) : null}
    </Video>
  );

describe("the Video component", () => {
  it("is registered for MDX", () => {
    expect(useMDXComponents().Video).toBe(Video);
  });

  it("is the browser's own player: controls, nothing loaded until played, inline on a phone, with its poster and its MP4", () => {
    const markup = render(PROPS);
    const tag = /<video\b[^>]*>/.exec(markup)?.[0] ?? "";
    expect(tag).toContain('controls=""');
    expect(tag).toContain('preload="none"');
    // React writes the attribute as `playsInline`; HTML attribute names are not case-sensitive.
    expect(tag).toMatch(/\splaysinline=""/i);
    expect(tag).toContain('poster="/docs/videos/xero-flow-poster.jpg"');
    expect(tag).toContain('aria-label="Bills from Xero"');
    expect(markup).toContain('<source src="/docs/videos/xero-flow.mp4" type="video/mp4"/>');
  });

  it("never plays on its own or loops, and embeds nothing from another site", () => {
    const markup = render(PROPS);
    const tag = /<video\b[^>]*>/.exec(markup)?.[0] ?? "";
    expect(tag).not.toMatch(/autoplay|loop|muted/i);
    expect(markup).not.toMatch(/<iframe|<embed|<object|<script/i);
    // Every file it names is on this site: the MP4, its poster and the fallback link.
    const named = [...markup.matchAll(/\s(?:src|poster|href)="([^"]*)"/g)].map((match) => match[1]);
    expect(named).toEqual(["/docs/videos/xero-flow-poster.jpg", "/docs/videos/xero-flow.mp4", "/docs/videos/xero-flow.mp4"]);
  });

  it("is a card at the column's width, 16:9 before it loads", () => {
    const markup = render(PROPS);
    const figure = /<figure class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
    expect(figure).toEqual(expect.arrayContaining(["rounded-2xl", "border", "border-line", "bg-surface", "shadow-surface", "overflow-hidden"]));
    const video = /<video\b[^>]*class="([^"]*)"/.exec(markup)?.[1].split(" ") ?? [];
    expect(video).toEqual(expect.arrayContaining(["block", "w-full", "h-auto", "aspect-video"]));
  });

  it("says below it what it is called, how long it is and what it shows", () => {
    const caption = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(render(PROPS))?.[1] ?? "";
    expect(caption).toContain("Bills from Xero");
    expect(caption).toContain('<span class="sr-only">Length: </span><time dateTime="PT1M52S">1:52</time>');
    expect(caption).toContain("The live product on Arc testnet, with demo data.");
  });

  it("holds its transcript under Read the transcript, closed until opened", () => {
    const markup = render(PROPS);
    const details = /<details\b[^>]*>([\s\S]*)<\/details>/.exec(markup);
    expect(details?.[0]).not.toMatch(/^<details[^>]*\bopen\b/);
    expect(details?.[1]).toMatch(/<summary[^>]*>[\s\S]*Read the transcript<\/summary>/);
    expect(details?.[1]).toContain("<p>First line.</p><p>Second line.</p>");
  });

  it.each(VIDEO_ATTRIBUTES.map((name) => [name] as const))("refuses to render without %s, or with it blank", (name) => {
    expect(() => render({ ...PROPS, [name]: undefined })).toThrow(new RegExp(`<Video> needs ${name}:`));
    expect(() => render({ ...PROPS, [name]: "  " })).toThrow(new RegExp(`<Video> needs ${name}:`));
  });

  it("names every missing attribute at once, refuses a length that is not minutes and seconds, and needs its transcript", () => {
    expect(() => render({ src: PROPS.src })).toThrow("<Video> needs poster, title, caption, duration:");
    expect(() => render({ ...PROPS, duration: "112s" })).toThrow(/minutes and seconds, such as 1:52/);
    expect(() => render(PROPS, false)).toThrow(/needs its transcript/);
  });

  it("writes its length for machines as an ISO 8601 duration", () => {
    expect(isoDuration("1:52")).toBe("PT1M52S");
    expect(isoDuration("0:09")).toBe("PT0M9S");
    expect(isoDuration("12:00")).toBe("PT12M0S");
    for (const bad of ["", "1:5", "1:60", "112", "1:52:00", "1m52s"]) expect(isoDuration(bad), bad).toBeNull();
  });
});

describe("Video in Markdown", () => {
  const SOURCE = [
    "Before.",
    "",
    "<Video",
    '  src="/docs/videos/xero-flow.mp4"',
    '  poster="/docs/videos/xero-flow-poster.jpg"',
    '  title="Bills [from] Xero"',
    '  duration="1:52"',
    '  caption="The live product on Arc testnet, with demo data."',
    ">",
    "",
    "First line.",
    "",
    "Second line.",
    "",
    "</Video>",
    "",
    "After.",
    "",
  ].join("\n");

  it("is a link to the file, made absolute, named with its title and length, then its caption and its transcript", () => {
    expect(mdxToMarkdown(SOURCE, ORIGIN)).toBe(
      [
        "Before.",
        `[Video: Bills \\[from\\] Xero (1:52)](${ORIGIN}/docs/videos/xero-flow.mp4)`,
        "*The live product on Arc testnet, with demo data.*",
        "**Transcript**",
        "First line.",
        "Second line.",
        "After.",
      ].join("\n\n") + "\n"
    );
  });

  it("refuses a video without an attribute or its transcript, with the page's words", () => {
    expect(() => mdxToMarkdown(SOURCE.replace('  duration="1:52"\n', ""), ORIGIN)).toThrow("<Video> needs duration:");
    expect(() => mdxToMarkdown(SOURCE.replace('  caption="The live product on Arc testnet, with demo data."\n', '  caption=" "\n'), ORIGIN)).toThrow("<Video> needs caption:");
    expect(() => mdxToMarkdown(SOURCE.replace("First line.\n\nSecond line.\n\n", ""), ORIGIN)).toThrow(/needs its transcript/);
  });

  it("is a block: MDX would read it inline inside a paragraph, so the converter refuses that", () => {
    const inline = 'Text <Video src="/a.mp4" poster="/a.jpg" title="A" caption="B" duration="1:00">Line.</Video> more.\n';
    expect(() => mdxToMarkdown(inline, ORIGIN)).toThrow(/block/);
  });

  it.each([
    ["guides/xero", "Bills from Xero, decided by the agent (1:52)", "/docs/videos/xero-flow.mp4", "Paid at the same amount as the bill: 59.54 USDC on Arc testnet."],
    ["guides/hubspot", "A deal from HubSpot, collected on Arc (1:55)", "/docs/videos/hubspot-flow.mp4", "HubSpot read it back the same. Collected: 20. Still owed: 0."],
  ] as const)("is in the %s guide's Markdown view, with its transcript", (slug, name, src, line) => {
    const md = pageMarkdown(slug, ORIGIN)!;
    expect(md).toContain(`[Video: ${name}](${ORIGIN}${src})`);
    expect(md).toContain("**Transcript**");
    expect(md).toContain(line);
  });
});
