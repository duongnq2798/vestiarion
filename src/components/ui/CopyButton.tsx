"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button, type ButtonProps } from "./Button";
import { Tooltip } from "./Tooltip";

export type CopyButtonProps = Omit<ButtonProps, "onClick" | "asChild" | "children" | "icon"> & {
  value: string;
  /** What is copied, for screen readers and the tooltip: “Copy transaction hash”. */
  label?: string;
  /** Visible text. Without it the button is an icon with a tooltip. */
  children?: ReactNode;
};

/** Copies `value`, says so for two seconds, and confirms with a toast. */
export function CopyButton({ value, label = "Copy", children, variant = "ghost", size, ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast("Copied to the clipboard");
    } catch {
      // The text is still on screen to copy by hand; there is no form to put this error in.
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  }

  const icon = copied ? <Check className="text-proof" /> : <Copy />;

  if (children) {
    return (
      <Button variant={variant} size={size ?? "sm"} icon={icon} onClick={copy} {...props}>
        {copied ? "Copied" : children}
      </Button>
    );
  }

  return (
    <Tooltip content={copied ? "Copied" : label}>
      <Button variant={variant} size={size ?? "icon-sm"} aria-label={label} onClick={copy} {...props}>
        {icon}
      </Button>
    </Tooltip>
  );
}
