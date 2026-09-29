"use client";

import { FileText, Hash, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/Command";
import { Kbd } from "@/components/ui/Kbd";
import { shortcutLabel } from "@/components/vx/command-items";
import { isSearchShortcut, searchDocs, searchHref, type SearchEntry } from "@/lib/docs/search";

export { isSearchShortcut };

const SearchContext = createContext<{ open: () => void } | null>(null);

const noSubscription = () => () => {};

/** "Ctrl K", or "⌘K" on a Mac; the server renders "Ctrl K" and a Mac switches after hydration. */
function useShortcutLabel(): string {
  return useSyncExternalStore(noSubscription, () => shortcutLabel(navigator.platform), () => shortcutLabel(""));
}

function Result({ entry, onSelect }: { entry: SearchEntry; onSelect: (entry: SearchEntry) => void }) {
  const Icon = entry.heading ? Hash : FileText;
  return (
    <CommandItem value={searchHref(entry)} onSelect={() => onSelect(entry)} className="items-start py-2">
      <Icon aria-hidden className="mt-0.5 text-ink-3" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{entry.heading ?? entry.title}</span>
        <span className="block truncate text-xs text-ink-3">{entry.heading ? `${entry.section} · ${entry.title}` : entry.section}</span>
        {entry.text && <span className="mt-0.5 line-clamp-1 text-xs text-ink-2">{entry.text}</span>}
      </span>
    </CommandItem>
  );
}

/**
 * Docs search: a dialog over the index built with the docs, opened with
 * Ctrl K or ⌘K from anywhere in the docs, or with a search button. With no
 * query it lists the pages by section; a query lists the pages and headings
 * that match every word. Choosing one goes to the page, at its heading.
 */
export function DocsSearchProvider({ index, children }: { index: SearchEntry[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      if (event.repeat) return;
      setOpen((current) => !current);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const context = useMemo(() => ({ open: () => setOpen(true) }), []);
  const results = useMemo(() => searchDocs(index, query), [index, query]);
  const bySection = useMemo(() => {
    const groups = new Map<string, SearchEntry[]>();
    for (const entry of index) if (!entry.heading) groups.set(entry.section, [...(groups.get(entry.section) ?? []), entry]);
    return [...groups];
  }, [index]);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  function go(entry: SearchEntry) {
    onOpenChange(false);
    router.push(searchHref(entry));
  }

  const searching = query.trim() !== "";

  return (
    <SearchContext.Provider value={context}>
      {children}
      <CommandDialog open={open} onOpenChange={onOpenChange} title="Search the docs" description="Find a page or a section of the docs" shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder="Search the docs…" />
        <CommandList>
          <CommandEmpty>
            No results for “<span className="text-ink">{query.trim()}</span>”.
          </CommandEmpty>
          {searching ? (
            results.map((entry) => <Result key={searchHref(entry)} entry={entry} onSelect={go} />)
          ) : (
            bySection.map(([section, entries]) => (
              <CommandGroup key={section} heading={section}>
                {entries.map((entry) => (
                  <Result key={searchHref(entry)} entry={entry} onSelect={go} />
                ))}
              </CommandGroup>
            ))
          )}
        </CommandList>
      </CommandDialog>
    </SearchContext.Provider>
  );
}

function useDocsSearch() {
  const context = useContext(SearchContext);
  if (!context) throw new Error("useDocsSearch must be used inside DocsSearchProvider");
  return context;
}

/** The header's search field: a button that opens search, with its shortcut from `sm` up and as an icon below. */
export function DocsSearchButton({ className }: { className?: string }) {
  const search = useDocsSearch();
  const shortcut = useShortcutLabel();
  return (
    <>
      <Button variant="secondary" size="icon" aria-label="Search the docs" onClick={search.open} className={cn("sm:hidden", className)}>
        <Search />
      </Button>
      <Button
        variant="secondary"
        onClick={search.open}
        className={cn("hidden w-56 justify-start gap-2.5 px-3 font-normal text-ink-3 shadow-none hover:text-ink sm:inline-flex", className)}
      >
        <Search aria-hidden />
        <span className="flex-1 text-left">Search the docs…</span>
        <Kbd>{shortcut}</Kbd>
      </Button>
    </>
  );
}

/** A plain "Search the docs" button, for a page that offers search in its body: the docs' not-found page. */
export function DocsSearchAction({ children = "Search the docs" }: { children?: ReactNode }) {
  const search = useDocsSearch();
  return (
    <Button icon={<Search />} onClick={search.open}>
      {children}
    </Button>
  );
}
