"use client";

import { ColumnsStep, CheckStep } from "@/components/intake/BillImport";
import { countFates } from "@/lib/bill-import/rows";
import { SAMPLE_LIST, SAMPLE_WORKSPACE, sampleFates } from "@/lib/bill-import/sample";
import { startingSettings } from "@/lib/bill-import/rows";
import { readTable } from "@/lib/bill-import/table";

/**
 * The import panel's columns and check steps for the import guide's screenshots, over the sample list
 * (`src/lib/bill-import/sample.ts`), read and checked exactly as the panel does it.
 */
export function BillImportShot({ step }: { step: "columns" | "check" }) {
  const table = readTable(SAMPLE_LIST);
  const list = { text: SAMPLE_LIST, source: "Pasted rows", table, legacy: false };
  const settings = { ...startingSettings(table, SAMPLE_WORKSPACE), direction: "payable" as const };
  const noop = () => {};
  if (step === "columns") {
    return <ColumnsStep list={list} settings={settings} workspace={SAMPLE_WORKSPACE} onChange={noop} onCheck={noop} onRestart={noop} pending={false} error="" />;
  }
  const checked = sampleFates(SAMPLE_LIST, settings, []);
  if (!checked.ok) return <p>{checked.message}</p>;
  return <CheckStep check={{ fates: checked.fates, counts: countFates(checked.fates) }} onBack={noop} onImport={noop} onDownload={noop} pending={false} error="" />;
}
