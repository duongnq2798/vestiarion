import { parseUnits } from "viem";

/**
 * A USDC figure as a person typed it (the agent's spending limit R7, a treasury contract's figures and cap C2), read
 * the same way wherever it is typed: blank is none; otherwise a decimal number of USDC above 0 with at most 6 decimal
 * places, commas read as thousands. Anything else is refused in words, never rounded or read as another number.
 * Browser-safe.
 */

export type FigureRead = { ok: true; value: number | null } | { ok: false; message: string };

const DECIMAL = /^-?\d+(\.\d+)?$/;

function cleaned(raw: string): string {
  return raw.trim().replace(/,/g, "");
}

/** The figure in USDC, or null for blank; `name` says which figure a refusal is about ("daily limit"). */
export function parseFigure(raw: string, name: string): FigureRead {
  const text = cleaned(raw);
  if (text === "") return { ok: true, value: null };
  if (!DECIMAL.test(text)) return { ok: false, message: `The ${name} must be a number of USDC.` };
  if ((text.split(".")[1] ?? "").length > 6) return { ok: false, message: `The ${name} can have at most 6 decimal places.` };
  const value = Number(text);
  if (!(value > 0)) return { ok: false, message: `The ${name} must be more than 0 USDC.` };
  return { ok: true, value };
}

/** The same figure in USDC's 6-decimal units, exactly as typed: no float in between. */
export function figureUnits(raw: string, name: string): { ok: true; units: bigint | null } | { ok: false; message: string } {
  const read = parseFigure(raw, name);
  if (!read.ok) return read;
  return { ok: true, units: read.value === null ? null : parseUnits(cleaned(raw), 6) };
}
