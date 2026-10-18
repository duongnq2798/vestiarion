"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";
import { redactPath, redactReferrer, redactTitle } from "@/lib/analytics/redact";

type GoogleAnalyticsProps = {
  measurementId: string;
};

type PageParameters = {
  page_location: string;
  page_path: string;
  page_referrer: string;
  page_title: string;
};

type Gtag = {
  (command: "set", parameters: Partial<PageParameters>): void;
  (command: "event", eventName: "page_view", parameters: PageParameters): void;
  (command: "event", eventName: "cta_click", parameters: { cta_id: string; page_path: string }): void;
};

/** A call to action's name, as `data-cta` gives it: lowercase words and hyphens only, so nothing else can ride along. */
export const CTA_ID = /^[a-z][a-z-]{0,39}$/;

export function GoogleAnalytics({ measurementId }: GoogleAnalyticsProps) {
  const pathname = usePathname();
  const [isInitialized, setIsInitialized] = useState(false);
  const serializedMeasurementId = JSON.stringify(measurementId);
  const serializedPagePath = JSON.stringify(redactPath(pathname));

  useEffect(() => {
    if (!isInitialized) return;

    const pagePath = redactPath(pathname);
    const analyticsWindow = window as Window & { gtag?: Gtag };
    const origin = window.location.origin;
    const parameters = {
      page_location: `${origin}${pagePath}`,
      page_path: pagePath,
      page_referrer: redactReferrer(document.referrer, origin),
      page_title: redactTitle(pathname, document.title),
    };
    analyticsWindow.gtag?.("set", parameters);
    analyticsWindow.gtag?.("event", "page_view", parameters);
  }, [isInitialized, pathname]);

  // Which call to action was chosen (landing clarity M1): a link marked `data-cta` sends its name and the redacted path,
  // and nothing about the person or what they typed.
  useEffect(() => {
    if (!isInitialized) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("[data-cta]") : null;
      const id = target?.getAttribute("data-cta") ?? "";
      if (!CTA_ID.test(id)) return;
      (window as Window & { gtag?: Gtag }).gtag?.("event", "cta_click", { cta_id: id, page_path: redactPath(window.location.pathname) });
    };
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, [isInitialized]);

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`}
        strategy="afterInteractive"
      />
      <Script id="google-analytics-init" strategy="afterInteractive" onReady={() => setIsInitialized(true)}>
        {`
          window.dataLayer = window.dataLayer || [];
          window.gtag = function gtag(){window.dataLayer.push(arguments);};
          window.gtag('js', new Date());
          window.gtag('set', {
            page_location: window.location.origin + ${serializedPagePath},
            page_path: ${serializedPagePath}
          });
          window.gtag('config', ${serializedMeasurementId}, {
            send_page_view: false,
            allow_google_signals: false,
            allow_ad_personalization_signals: false
          });
        `}
      </Script>
    </>
  );
}
