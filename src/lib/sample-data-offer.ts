/**
 * When the console offers sample data (sample-data design §1, S1): to someone
 * who adds records, in a sandbox whose payments are simulated, before anything
 * has been added. The server refuses the same cases on its own; this only
 * decides whether the card shows.
 */
export function offerSampleData(input: {
  canWrite: boolean;
  mode: "sandbox" | "live";
  chainMode: "live" | "simulate";
  counterpartyCount: number;
}): boolean {
  return input.canWrite && input.mode === "sandbox" && input.chainMode === "simulate" && input.counterpartyCount === 0;
}
