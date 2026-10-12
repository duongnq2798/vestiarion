"use client";

import { useRouter } from "next/navigation";
import { useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import type { SortOption } from "./types";

/** The list's order, in the address: choosing one opens the first page in that order. */
export function SortSelect({ value, options }: { value: string; options: SortOption[] }) {
  const router = useRouter();
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs text-ink-3">
        Sort
      </label>
      <Select
        value={value}
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option) router.push(option.href, { scroll: false });
        }}
      >
        <SelectTrigger id={id} size="sm" className="w-auto min-w-[10.5rem]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
