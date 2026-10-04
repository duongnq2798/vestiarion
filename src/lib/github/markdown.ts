/**
 * Text as it is, in Markdown: every ASCII punctuation mark escaped, so a name cannot become a link or HTML. GitHub finds
 * mentions and issue references in the rendered text, after the escapes are gone, so a word joiner (U+2060) follows
 * each `@` and `#`: a name cannot mention anyone or point at an issue either (GitHub App design G4).
 */
export function literal(text: string): string {
  return text.replace(/[!-/:-@[-`{-~]/g, (mark) => (mark === "@" || mark === "#" ? `\\${mark}⁠` : `\\${mark}`));
}
