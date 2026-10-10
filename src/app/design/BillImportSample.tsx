"use client";

import { useRef } from "react";
import BillImport, { type BillImportActions } from "@/components/intake/BillImport";
import { countImported, importMessage, type ExistingInvoice } from "@/lib/bill-import/rows";
import { countFates, sampleFates, sampleImport, SAMPLE_WORKSPACE } from "@/lib/bill-import/sample";

/**
 * The import panel on the design page, its check and import answered in the browser from a sample workspace
 * (`src/lib/bill-import/sample.ts`), so every step can be tried without a server.
 */
export function BillImportSample() {
  const existing = useRef<ExistingInvoice[]>([]);
  const actions: BillImportActions = {
    check: async (_orgSlug, text, settings) => {
      const checked = sampleFates(text, settings, existing.current);
      if (!checked.ok) return { ok: false, message: checked.message };
      const counts = countFates(checked.fates);
      return { ok: true, message: "", fates: checked.fates, counts };
    },
    importList: async (_orgSlug, text, settings) => {
      const checked = sampleFates(text, settings, existing.current);
      if (!checked.ok) return { ok: false, message: checked.message };
      const fates = sampleImport(checked.fates, existing.current);
      const counts = countImported(fates);
      return { ok: true, message: importMessage(counts), fates, counts };
    },
  };
  return <BillImport orgSlug="design" workspace={SAMPLE_WORKSPACE} actions={actions} />;
}
