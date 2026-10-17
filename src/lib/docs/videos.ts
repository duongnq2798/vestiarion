/**
 * The guides' walkthrough videos: MP4 files and their posters under
 * `public/docs/videos/`, each shown by a `<Video>` in the guide it walks
 * through, with its transcript written between the tags in the MDX. The page
 * (src/components/docs/Video.tsx) and the `.md` view (`MDX_TO_MARKDOWN` in
 * ./markdown.ts) refuse one that leaves out an attribute or its transcript,
 * with the same words.
 */

export const VIDEO_DIR = "/docs/videos/";

/** Every attribute a `<Video>` needs, in the order they are named when missing. */
export const VIDEO_ATTRIBUTES = ["src", "poster", "title", "caption", "duration"] as const;

export type VideoAttribute = (typeof VIDEO_ATTRIBUTES)[number];

/**
 * A guide's walkthrough: the guide whose "Watch it" section shows it, its title and length as that `<Video>` gives
 * them, and the guides it also walks through, which point to it. The app links each from beside the "Docs" link to
 * any of those guides (`DocsLink`, the getting-started checklist); `tests/docs-videos.test.tsx` holds this list to the
 * `<Video>`s in the MDX.
 */
export interface GuideVideo {
  guide: string;
  title: string;
  duration: string;
  also?: readonly string[];
}

export const GUIDE_VIDEOS: readonly GuideVideo[] = [
  { guide: "guides/try-it", title: "See your first decision", duration: "1:46" },
  { guide: "guides/first-payment", title: "Your first payment, paid by the agent", duration: "1:32" },
  { guide: "guides/shadow-mode", title: "Shadow mode on your own bills", duration: "1:33" },
  { guide: "guides/controls", title: "How payments are controlled", duration: "1:25" },
  { guide: "guides/go-live", title: "Take a workspace live on Arc", duration: "1:26" },
  { guide: "guides/collections", title: "Get paid by a customer on Arc", duration: "1:05" },
  { guide: "guides/early-payment-offers", title: "Early-payment offers made by the agent", duration: "1:13" },
  { guide: "guides/pay-a-contractor", title: "Pay a contractor for verified work", duration: "1:01" },
  { guide: "guides/quickbooks", title: "Bills from QuickBooks and Zoho Books", duration: "1:00", also: ["guides/zohobooks"] },
  { guide: "guides/import-bills", title: "Bills that arrive on their own", duration: "1:17", also: ["guides/email-invoices", "guides/invoice-capture"] },
  { guide: "guides/bank-payouts", title: "Pay a vendor's bank account in pesos", duration: "1:01" },
  { guide: "guides/evidence", title: "Evidence and the audit export", duration: "0:56", also: ["guides/audit-export"] },
  { guide: "guides/xero", title: "Bills from Xero, decided by the agent", duration: "1:52" },
  { guide: "guides/hubspot", title: "A deal from HubSpot, collected on Arc", duration: "1:55" },
];

/**
 * The walkthrough a link to a docs page can offer beside it, with where it plays (its guide's "Watch it" section), or
 * null: a link to one heading of a page, or to a page no walkthrough covers, offers none.
 */
export function videoFor(href: string): (GuideVideo & { watch: string }) | null {
  if (href.includes("#")) return null;
  const slug = href.replace(/^\/docs\//, "").replace(/\/$/, "");
  const video = GUIDE_VIDEOS.find((entry) => entry.guide === slug || entry.also?.includes(slug));
  return video ? { ...video, watch: `/docs/${video.guide}#watch-it` } : null;
}

/** A length written as minutes and seconds, `1:52`, as an ISO 8601 duration, `PT1M52S`; null for anything else. */
export function isoDuration(duration: string): string | null {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(duration.trim());
  return match ? `PT${Number(match[1])}M${Number(match[2])}S` : null;
}

/**
 * What is wrong with a `<Video>`, in words, or null when nothing is: an
 * attribute missing or blank, a duration that is not minutes and seconds, or
 * no transcript.
 */
export function videoProblem(attributes: Partial<Record<string, unknown>>, hasTranscript: boolean): string | null {
  const missing = VIDEO_ATTRIBUTES.filter((name) => {
    const value = attributes[name];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    return `<Video> needs ${missing.join(", ")}: a src, a poster, a title, a caption and a duration are each required`;
  }
  if (!isoDuration(attributes.duration as string)) {
    return `<Video> has duration "${attributes.duration as string}": write it as minutes and seconds, such as 1:52`;
  }
  if (!hasTranscript) return "<Video> needs its transcript, written between its opening and closing tags";
  return null;
}
