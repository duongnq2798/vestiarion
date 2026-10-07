"use client";

import { ChevronRight, Smartphone } from "lucide-react";
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { Disclosure } from "@/components/ui/Disclosure";
import { handoffView, qrPath } from "@/lib/passkey-handoff";

/** "Use your phone instead" under a passkey button: why and when in src/lib/passkey-handoff.ts. */

const neverChanges = () => () => {};
const FINE_POINTER = "(hover: hover) and (pointer: fine)";

const HandoffUrl = createContext<string | null>(null);

/** Gives the handoff a page to show where this page's own address is not the one to scan: the guide's screenshots. */
export function PhoneHandoffUrl({ url, children }: { url: string; children: ReactNode }) {
  return <HandoffUrl.Provider value={url}>{children}</HandoffUrl.Provider>;
}

/** Whether this device keeps passkeys of its own, asked once a page: null until the browser answers. */
const device: { keeps: boolean | null; asked: boolean; listeners: Set<() => void> } = { keeps: null, asked: false, listeners: new Set() };

function subscribeDevice(onChange: () => void): () => void {
  device.listeners.add(onChange);
  if (!device.asked) {
    device.asked = true;
    window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.()
      .then((keeps) => {
        device.keeps = keeps;
        device.listeners.forEach((listener) => listener());
      })
      .catch(() => {});
  }
  return () => {
    device.listeners.delete(onChange);
  };
}

function subscribePointer(onChange: () => void): () => void {
  const query = window.matchMedia(FINE_POINTER);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** The handoff for this device: open where it keeps no passkey of its own, folded on a computer, left out on a phone. */
export function PhoneHandoff({ kind }: { kind: "create" | "confirm" }) {
  const deviceKeepsPasskeys = useSyncExternalStore(subscribeDevice, () => device.keeps, () => null);
  const finePointer = useSyncExternalStore(subscribePointer, () => window.matchMedia(FINE_POINTER).matches, () => null);
  const given = useContext(HandoffUrl);
  const here = useSyncExternalStore(neverChanges, () => window.location.href, () => null);
  const url = given ?? here;
  const view = handoffView({ finePointer, deviceKeepsPasskeys });
  if (view === "hidden" || !url) return null;
  return <PhoneHandoffPanel kind={kind} url={url} open={view === "open"} />;
}

/** A code that opens `url` on a phone, with what to do there. */
export function PhoneHandoffPanel({ kind, url, open }: { kind: "create" | "confirm"; url: string; open: boolean }) {
  const { size, path } = qrPath(url);
  return (
    <Disclosure
      variant="bare"
      defaultOpen={open}
      summary={
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-2 transition-colors duration-150 ease-standard hover:text-ink">
          <ChevronRight aria-hidden className="size-4 shrink-0 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
          <Smartphone aria-hidden className="size-4 shrink-0 text-ink-3" />
          Use your phone instead
        </span>
      }
      contentClassName="pt-3"
    >
      <div className="flex flex-wrap items-start gap-4">
        <svg
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label="A code that opens this page on your phone"
          shapeRendering="crispEdges"
          className="size-36 shrink-0 rounded-lg border border-line bg-surface"
        >
          <path className="fill-ink" d={path} />
        </svg>
        <div className="min-w-0 flex-1 space-y-2 text-sm leading-relaxed text-ink-2">
          {kind === "create" ? (
            <p>
              Scan this code with your phone to open this page there, and create the passkey on the phone itself. From a computer with no passkey of its
              own, such as a Windows PC without Windows Hello, the browser asks your phone over Bluetooth, and can stay on &quot;Connecting to your
              device&quot;.
            </p>
          ) : (
            <p>
              Scan this code with the phone that holds the passkey to open this page there, and confirm on the phone. From a computer, the browser
              reaches a passkey on your phone over Bluetooth, and can stay on &quot;Connecting to your device&quot;.
            </p>
          )}
          <p className="break-all font-mono text-xs text-ink-3">{url}</p>
        </div>
      </div>
    </Disclosure>
  );
}
