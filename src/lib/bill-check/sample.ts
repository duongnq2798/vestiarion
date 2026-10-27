/**
 * The sample list the free bill list check offers (docs/superpowers/specs/2026-10-28-check-bills-design.md CB10): made-up
 * vendors and amounts in USD, its dates counted from today so its deadlines always fall in the next 7 days. It holds one
 * of each finding: a bill sent twice, the same invoice keyed with its number written another way, a monthly charge, a
 * discount ending soon, a late fee starting soon, and a row whose due date is not a real day.
 */

/** The name the sample shows under, wherever it shows. */
export const SAMPLE_SOURCE = "Sample list (made-up vendors)";

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The sample as a CSV, its dates counted from `today` (`YYYY-MM-DD`). */
export function sampleBillList(today: string): string {
  const day = (days: number) => addDays(today, days);
  return [
    "Vendor,Bill no.,Description,PO number,Due date,Amount,Currency,Discount %,Discount deadline,Late fee per month (%)",
    `Northwind Hosting,NH-2207,Cloud hosting,,${day(-26)},240.00,USD,,,`,
    `Northwind Hosting,NH-2241,Cloud hosting,,${day(3)},240.00,USD,,,`,
    `Bluebell Print Co.,BP-1042,Brochures,PO-881,${day(10)},1250.00,USD,,,`,
    `Bluebell Print Co,bp 1042,Brochures,PO 881,${day(12)},1250.00,USD,,,`,
    `Lakeside Freight,LF-3290,Freight,,${day(-21)},960.00,USD,,,`,
    `Lakeside Freight,LF-3310,Freight,,${day(9)},980.00,USD,2,${day(3)},`,
    `Juniper Office Supply,JO-5521,Toner and paper,,${day(4)},412.00,USD,,,1.5`,
    `Maple Street Cleaning,MS-301,Office cleaning,,${day(6)},450.00,USD,,,`,
    `Maple Street Cleaning,MS-301,Office cleaning,,${day(6)},450.00,USD,,,`,
    `Redwood Legal,RL-88,Contract review,,${day(20)},1800.00,USD,,,`,
    // February 30 is no day in any year.
    `Orchard Signs,OS-14,Window decals,,${today.slice(0, 4)}-02-30,145.00,USD,,,`,
    `Northwind Hosting,NH-2275,Cloud hosting,,${day(32)},240.00,USD,,,`,
    `Cedar Coffee Roasters,CC-610,Office coffee,,${day(14)},86.50,USD,,,`,
  ].join("\n");
}
