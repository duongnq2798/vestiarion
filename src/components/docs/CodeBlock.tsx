import { bundledLanguages, codeToHtml, type BundledLanguage } from "shiki";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/CopyButton";

/** Languages shiki knows by name or alias; anything else is shown as plain text. */
function knownLanguage(lang: string | undefined): BundledLanguage | "text" {
  if (!lang) return "text";
  const lower = lang.toLowerCase();
  return Object.hasOwn(bundledLanguages, lower) ? (lower as BundledLanguage) : "text";
}

/**
 * A dark code panel, highlighted on the server by shiki: nothing about it
 * runs in the browser but the copy button. A long line scrolls inside the
 * panel, never the page. `label` defaults to the language.
 */
export async function CodeBlock({ code, lang, label, className }: { code: string; lang?: string; label?: string; className?: string }) {
  const language = knownLanguage(lang);
  const html = await codeToHtml(code, { lang: language, theme: "github-dark" });

  return (
    <div className={cn("my-6 overflow-hidden rounded-xl border border-ink/10 bg-ink text-ground shadow-control", className)}>
      <div className="flex h-10 items-center justify-between gap-3 border-b border-ground/10 pl-4 pr-1">
        <span className="truncate font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ground/70">{label ?? (lang || "text")}</span>
        <CopyButton value={code} label="Copy code" className="text-ground/70 hover:bg-ground/10 hover:text-ground active:bg-ground/15" />
      </div>
      <div
        className={cn(
          "overflow-x-auto",
          // shiki's own <pre>: it scrolls (and takes focus, so a keyboard can scroll it) on the panel's colour.
          "[&_pre]:overflow-x-auto [&_pre]:bg-transparent! [&_pre]:px-4 [&_pre]:py-3.5 [&_pre]:font-mono [&_pre]:text-[0.8125rem] [&_pre]:leading-relaxed",
          "[&_pre]:outline-hidden [&_pre:focus-visible]:ring-2 [&_pre:focus-visible]:ring-inset [&_pre:focus-visible]:ring-agent-line"
        )}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
