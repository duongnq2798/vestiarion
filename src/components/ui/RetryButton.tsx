"use client";

import { RotateCcw } from "lucide-react";
import { useTransition } from "react";
import { Button, type ButtonProps } from "./Button";

/**
 * An error screen's way back (docs/superpowers/specs/2026-11-14-loading-states-design.md L7): it asks for the part
 * that failed again, and is busy until that part has been fetched and shown, or has failed once more.
 */
export function RetryButton({ retry, children = "Try again", ...props }: Omit<ButtonProps, "onClick" | "loading" | "asChild"> & { retry: () => void }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button icon={<RotateCcw />} loading={pending} onClick={() => startTransition(() => retry())} {...props}>
      {children}
    </Button>
  );
}
