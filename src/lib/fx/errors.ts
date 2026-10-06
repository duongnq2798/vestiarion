/** Why Circle's Stablecoin Service gave no usable quote (EURC invoices design E4; EURC swap design S1). */
export class FxQuoteError extends Error {
  constructor(
    readonly code: "unavailable" | "no_route" | "malformed",
    /** Why, when it is not Circle's answer: a network without the Stablecoin Service (network threading P5). */
    message?: string
  ) {
    super(
      message ??
      (code === "no_route"
        ? "No EURC→USDC route on Arc testnet right now"
        : code === "malformed"
          ? "The EURC→USDC quote could not be read"
          : "The EURC→USDC quote service did not answer")
    );
    this.name = "FxQuoteError";
  }
}
