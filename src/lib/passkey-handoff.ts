import { encode } from "uqr";

/**
 * "Use your phone instead" under a passkey button (2026-10-07): a code that opens the same page on a phone, so the
 * passkey is made or used there rather than reached from the computer over the browser's Bluetooth link to the phone.
 * That link stayed on "Connecting to your device" on the partner's Windows PC, with no Windows Hello, while the same page
 * on the iPhone made the treasury's passkey at once. Browser-safe: the Go live panel draws it.
 */

export type HandoffView = "hidden" | "collapsed" | "open";

/** Open where the device keeps no passkey of its own; folded on a computer; left out on a phone, and before it is known. */
export function handoffView(input: { finePointer: boolean | null; deviceKeepsPasskeys: boolean | null }): HandoffView {
  if (input.deviceKeepsPasskeys === false) return "open";
  return input.finePointer === true ? "collapsed" : "hidden";
}

/** A page's QR code as one SVG path of unit squares, with a quiet zone of two modules, for the page's ink to fill. */
export function qrPath(url: string): { size: number; path: string } {
  const { data } = encode(url, { border: 2 });
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    })
  );
  return { size: data.length, path };
}
