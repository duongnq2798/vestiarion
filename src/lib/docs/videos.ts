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
