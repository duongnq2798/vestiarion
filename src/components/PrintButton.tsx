"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/Button";

/** Opens the browser's print dialog, where "Save as PDF" makes the PDF (payee lock evidence EP10). */
export function PrintButton({ label = "Print or save as PDF" }: { label?: string }) {
  return (
    <Button type="button" size="sm" variant="secondary" onClick={() => window.print()}>
      <Printer aria-hidden />
      {label}
    </Button>
  );
}
