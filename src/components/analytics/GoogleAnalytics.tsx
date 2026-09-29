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
};

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
