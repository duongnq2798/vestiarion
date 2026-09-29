"use client";

import { LayoutGroup, m } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { createContext, useContext, useId, useState, type ComponentProps } from "react";
import { cn } from "./cn";
import { MOTION } from "./tokens";

const ActiveTab = createContext<string | undefined>(undefined);

export type TabsProps = Omit<ComponentProps<typeof TabsPrimitive.Root>, "value" | "defaultValue" | "onValueChange"> & {
  defaultValue: string;
  onValueChange?: (value: string) => void;
};

/**
 * Tabs whose selected marker glides to the tab chosen next. Two sets of tabs
 * on one page never trade markers: each has its own layout group.
 */
export function Tabs({ defaultValue, onValueChange, className, children, ...props }: TabsProps) {
  const [value, setValue] = useState(defaultValue);
  const group = useId();
  return (
    <ActiveTab.Provider value={value}>
      <LayoutGroup id={group}>
        <TabsPrimitive.Root
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onValueChange?.(next);
          }}
          className={cn("flex flex-col gap-4", className)}
          {...props}
        >
          {children}
        </TabsPrimitive.Root>
      </LayoutGroup>
    </ActiveTab.Provider>
  );
}

/** Tabs that do not fit scroll sideways inside the list, never the page. */
export function TabsList({ className, children, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List {...props} asChild>
      {/* `layoutScroll` lets the gliding marker account for the list's own scroll offset. */}
      <m.div
        layoutScroll
        className={cn("inline-flex h-11 w-full max-w-full items-stretch gap-1 overflow-x-auto rounded-xl border border-line bg-raised/60 p-1 [scrollbar-width:none] sm:h-10 sm:w-fit", className)}
      >
        {children}
      </m.div>
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, className, children, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  const active = useContext(ActiveTab) === value;
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "relative inline-flex flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg px-3 text-sm font-medium text-ink-2 outline-hidden transition-colors duration-150 ease-standard hover:text-ink focus-visible:ring-4 focus-visible:ring-agent-soft data-[state=active]:text-ink sm:flex-none [&_svg]:size-4",
        className
      )}
      {...props}
    >
      {active && (
        <m.span data-tab-indicator="" aria-hidden layoutId="tab-indicator" transition={MOTION.spring} className="absolute inset-0 rounded-lg border border-line bg-surface shadow-control" />
      )}
      <span className="relative inline-flex items-center gap-2">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-hidden duration-200 ease-standard data-[state=active]:animate-in data-[state=active]:fade-in-0", className)} {...props} />;
}
