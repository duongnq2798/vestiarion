"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/Button";

/**
 * Save as PDF (docs/superpowers/specs/2026-10-22-receipt-v2-design.md RV5): the browser's print dialog, where the receipt
 * saves as a PDF. The page leaves the site's header and footer, this button and the disclosure out of print.
 */
export function SavePdfButton() {
  return (
    <Button type="button" size="sm" variant="secondary" icon={<Printer />} className="print:hidden" onClick={() => window.print()}>
      Save as PDF
    </Button>
  );
}
